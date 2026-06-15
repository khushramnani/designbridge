# DesignBridge — Technical Specification

| | |
|---|---|
| **Version** | 1.0 |
| **Date** | 2026-06-12 |
| **Audience** | Implementing engineers/agents. This is the build reference. |
| **Companion docs** | `docs/PRD.md` (requirements + priorities), `IMPROVEMENT-PLAN.md` (fidelity work, Track B) |

**Rules for implementing agents:**

1. Read `docs/PRD.md` first. Requirement IDs (FR-x.y) in this spec refer to it.
2. Never change the capture schema without a version bump and updating `packages/schema` + its compat tests.
3. TDD where a contract exists (schema validation, REST handlers, WS protocol, pairing). Run `test/run-capture-tests.js` and `test/run-plugin-tests.js` after any change to `capture-core` or `figma-builder` — they must stay green.
4. Existing engine code (`extension/content.js`, `figma-plugin/code.js`) is battle-tested. Phase 0 *moves* it; do not rewrite logic while moving it.
5. Every silent failure is a bug. Degradations must produce a `warnings[]` entry that reaches the user.
6. No secrets in client bundles (extension, plugin UI, web). Secrets live in server env only.

---

## 1. System architecture

```
ENTRY POINTS                          VPS (Docker Compose)                 OUTPUT
┌──────────────────┐                 ┌─────────────────────────────┐
│ Chrome Extension │──REST──────────▶│ caddy :443 (TLS)            │
└──────────────────┘                 │   ├─ relay  :8080           │     ┌──────────────┐
┌──────────────────┐                 │   │   REST + WS hub         │─WS─▶│ Figma Plugin │
│ MCP Server       │──internal──────▶│   │   pairing/auth/queue    │     │  ws client   │
│ (same compose)   │                 │   ├─ mcp    :8081           │     │  builder     │
└──────────────────┘                 │   └─ worker (pg-boss poll)  │     │  context     │
┌──────────────────┐                 │       Playwright/Chromium   │     └──────────────┘
│ curl / scripts   │──REST──────────▶│       runs capture-core     │
└──────────────────┘                 └─────────────────────────────┘
                                       Supabase: Postgres (data + pg-boss queue)
                                                 Storage (assets, payloads)
                                       Vercel:   apps/web (designbridge.io)
```

Data flow, `capture` kind: extension captures → uploads assets to Storage (presigned) → `POST /v1/renders` with capture JSON → relay persists + enqueues → pushes `render.new` over WS → plugin fetches payload + assets → builds → acks.

Data flow, `html`/`url` kind: sender posts HTML/URL → relay enqueues translation job → worker renders in sandboxed Chromium, injects `capture-core`, produces capture JSON + assets → uploads → re-enqueues as delivery → same as above.

## 2. Repository layout & tooling

```
designbridge/
├── packages/
│   ├── schema/          # JSON Schema + TS types + validator (zod). THE contract.
│   ├── capture-core/    # capture engine lib → esbuild IIFE bundle + ESM
│   ├── figma-builder/   # builder lib (plugin + test harness consume)
│   └── client/          # typed relay REST client (fetch-based, zero deps)
├── apps/
│   ├── extension/       # Chrome MV3
│   ├── figma-plugin/    # plugin shell (ui.html + code entry)
│   ├── relay/           # Fastify + ws
│   ├── worker/          # Playwright + pg-boss consumer
│   ├── mcp/             # @modelcontextprotocol/sdk server (Streamable HTTP)
│   └── web/             # Next.js (Vercel)
├── test/                # golden corpus + harnesses (existing, extended)
├── infra/               # docker-compose.yml, Caddyfile, deploy scripts
└── docs/                # PRD.md, TECHNICAL-SPEC.md, runbooks
```

**Tooling:** pnpm workspaces · TypeScript 5 strict (`noUncheckedIndexedAccess`) · esbuild for bundles · vitest for unit tests · eslint + prettier · GitHub Actions CI. Node 22 LTS everywhere.

**Migration rule (Phase 0):** `content.js` and `code.js` move into packages *verbatim* first (wrapped in TS files with `// @ts-nocheck`), bundles are produced, extension/plugin consume the bundles, existing test harnesses pass. Typing is incremental afterwards.

## 3. Capture schema (`packages/schema`) — v1.0.0

Envelope (current capture format `0.6.0` becomes the `root` tree of v1.0.0, unchanged):

```jsonc
{
  "schemaVersion": "1.0.0",
  "source": { "kind": "extension" | "server-render" | "direct",
              "tool": "claude-design" | "generic", "url": "https://..." },
  "capturedAt": "ISO-8601",
  "viewport": { "width": 1440, "height": 900, "dpr": 2 },
  "root": { /* node tree — existing format from content.js, unchanged */ },
  "assets": [
    { "id": "sha256:<hex>", "kind": "raster" | "image" | "font",
      "mime": "image/png", "bytes": 123456,
      "storagePath": "assets/sha256/<hex>" }
  ],
  "fonts": [ { "family": "Inter", "weights": [400, 700], "matched": "Inter" } ],
  "warnings": [ { "code": "raster-region" | "font-substituted" | "size-capped" | "...",
                  "nodeId": "n42", "detail": "human-readable reason" } ]
}
```

Rules:

- Node tree references binary data **only** via `assetId` (`sha256:` form). No inline base64 in v1 relay transfers. (Clipboard fallback may still inline — the schema allows `dataUrl` as an alternative to `assetId` for that path only.)
- Assets are content-addressed (sha256 of bytes) and deduplicated globally.
- Versioning: additive optional fields → minor bump; anything else → major bump. Receiver (plugin) accepts same-major, warns on newer-minor, rejects different-major with upgrade message (FR-2.4).
- `packages/schema` exports: zod schemas, inferred TS types, `validateCapture()`, `SCHEMA_VERSION`, and `isCompatible(producer, consumer)`.
- CI compat test: every fixture in `test/fixtures/` must validate against the current schema; a stored copy of the previous-minor schema must also accept current fixtures (no accidental breaking changes).

## 4. Database schema (Supabase Postgres)

Migrations live in `apps/relay/migrations/`, applied via Supabase CLI. Relay uses the **service-role key** (server-side only); RLS enabled with deny-all for anon — the web app reads via its own authenticated policies (user sees own rows only).

```sql
create table users (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  created_at timestamptz not null default now()
);

create table api_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id),
  key_hash text not null unique,            -- sha256(raw key)
  key_prefix text not null,                 -- "db_live_a1b2" for display
  name text,
  rate_limit_per_min int not null default 10,
  daily_render_limit int not null default 100,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create table channels (
  id uuid primary key default gen_random_uuid(),
  plugin_token_hash text unique,            -- long-lived token, hashed
  label text,                               -- e.g. Figma file/user hint
  last_connected_at timestamptz,
  created_at timestamptz not null default now()
);

create table pairings (
  code text primary key,                    -- 6 chars, A-Z2-9 (no 0/O/1/I)
  channel_id uuid not null references channels(id),
  expires_at timestamptz not null,          -- now() + 10 min
  claimed_by_key uuid references api_keys(id),
  claimed_at timestamptz
);

create table key_channels (                 -- which keys may send to which channels
  api_key_id uuid not null references api_keys(id),
  channel_id uuid not null references channels(id),
  is_default boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (api_key_id, channel_id)
);

create type render_kind as enum ('capture','html','url');
create type render_status as enum
  ('queued','translating','delivering','delivered','done','failed');

create table renders (
  id uuid primary key default gen_random_uuid(),
  api_key_id uuid not null references api_keys(id),
  channel_id uuid not null references channels(id),
  kind render_kind not null,
  status render_status not null default 'queued',
  schema_version text,
  payload_path text,                        -- Storage path of capture JSON
  payload_bytes int,
  name text,
  warnings jsonb not null default '[]',
  error jsonb,                              -- { code, message }
  timing jsonb not null default '{}',       -- { translateMs, deliverMs, buildMs }
  created_at timestamptz not null default now(),
  done_at timestamptz
);
create index on renders (api_key_id, created_at desc);
create index on renders (channel_id, status);

create table assets (
  hash text primary key,                    -- "sha256:<hex>"
  mime text not null,
  bytes int not null,
  storage_path text not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz not null default now()
);

create table render_assets (
  render_id uuid not null references renders(id),
  asset_hash text not null references assets(hash),
  primary key (render_id, asset_hash)
);
```

Queue: **pg-boss** (its own schema in the same database). Jobs: `translate` (worker consumes), `deliver` (relay consumes → WS push). Asset GC: daily pg-boss cron deletes assets with `last_used_at < now() - interval '7 days'` and no live render references (NFR-5).

## 5. Relay REST API

Base: `https://relay.designbridge.io`. Auth: `Authorization: Bearer db_live_...` unless noted. All errors:

```json
{ "error": { "code": "invalid_api_key", "message": "...", "requestId": "..." } }
```

Error codes: `invalid_api_key` 401 · `revoked_api_key` 401 · `rate_limited` 429 (+ `Retry-After`) · `quota_exceeded` 429 · `channel_not_paired` 409 · `channel_offline` 200-with-status-queued (not an error) · `payload_too_large` 413 · `invalid_payload` 422 (+ zod issues) · `pairing_code_invalid` 404 · `pairing_code_expired` 410 · `render_not_found` 404 · `internal` 500.

### `POST /v1/renders` (FR-3.1)
```jsonc
// kind: capture (extension / pre-captured)
{ "channel": "uuid | 'default'", "name": "Pricing page",
  "payload": { "kind": "capture", "capture": { /* schema v1 envelope */ } } }
// kind: html (MCP / REST users)
{ "channel": "default", "name": "Dashboard",
  "payload": { "kind": "html", "html": "<!doctype html>...",
               "viewport": { "width": 1440, "height": 900 } } }   // viewport optional
// kind: url
{ "channel": "default", "payload": { "kind": "url", "url": "https://..." } }
```
Response `202`: `{ "renderId": "uuid", "status": "queued" | "translating", "statusUrl": "/v1/renders/<id>" }`.
Limits: request body ≤ 2 MB (`capture` JSON must externalize assets first); `html` ≤ 1 MB; reject inline base64 > 100 KB total with `payload_too_large` and the message "upload assets via /v1/assets/presign".

### `GET /v1/renders/:id`
`{ "renderId", "status", "warnings": [...], "error": null, "timing": {...}, "createdAt", "doneAt" }`
Terminal statuses: `done`, `failed`. Poll interval guidance: 1s. (SSE upgrade is post-beta.)

### `POST /v1/assets/presign`
Request: `{ "assets": [ { "hash": "sha256:...", "mime": "image/png", "bytes": 123456 } ] }` (≤ 50 per call, ≤ 20 MB per asset).
Response: `{ "uploads": [ { "hash", "uploadUrl": "...presigned PUT...", "exists": false } ] }` — `exists: true` means dedup hit, skip upload. Client uploads directly to Supabase Storage, then submits the render referencing hashes.

### `POST /v1/pair` (FR-3.3)
Request: `{ "code": "K7M3QF" }`. Binds calling API key ↔ the code's channel (inserts `key_channels`, marks pairing claimed).
Response: `{ "channelId": "uuid", "label": "..." }`.
Rate limit: 5 attempts/min per key and per IP; 20 failed attempts/hour per IP → 1h lockout.

### `GET /v1/channels`
Channels bound to the calling key: `{ "channels": [ { "id", "label", "isDefault", "online": true, "lastConnectedAt" } ] }`.

### `POST /v1/context` (FR-3.7)
Request: `{ "channel": "default", "scope": "selection" | "page" }`. Relay round-trips to plugin (§6), 15s timeout → `504 context_timeout` if plugin doesn't answer; `409 channel_not_paired` / `503 channel_offline` otherwise.
Response: `{ "context": { /* simplified node JSON, §6 context.response */ } }`.

### `GET /v1/health` (no auth)
`{ "ok": true, "version": "...", "ws": { "connections": n }, "queue": { "translate": n, "deliver": n } }`.

**Rate limiting:** token bucket per API key (default 10 req/min on `POST /v1/renders`, burst 5) + per-IP global bucket. In-memory (single node) behind an interface so Redis can replace it when multi-node (NFR-6).

## 6. WebSocket protocol (relay ↔ plugin)

Endpoint: `wss://relay.designbridge.io/v1/ws`. Subprotocol: `designbridge.v1`. All frames are JSON `{ "type": "...", ... }`. Heartbeat: server pings every 30s; connection dropped after 2 missed pongs. Plugin reconnects with exponential backoff (1s → 2s → 4s → … cap 60s, jitter).

### Connection & pairing
| Frame | Direction | Payload |
|---|---|---|
| `hello` | plugin → relay | `{ pluginVersion, schemaVersion, token? }` — `token` absent on first run |
| `hello.ok` | relay → plugin | `{ channelId, paired: bool, serverSchemaVersion }` |
| `pair.code` | relay → plugin | `{ code, expiresAt }` — sent when unpaired (new code on expiry) |
| `paired` | relay → plugin | `{ keyPrefix, channelToken }` — plugin persists `channelToken` via `figma.clientStorage` |
| `error` | relay → plugin | `{ code, message, fatal: bool }` |

First connection: plugin sends `hello` without token → relay creates channel + pairing code → `pair.code`. After `POST /v1/pair` succeeds, relay sends `paired` with the long-lived `channelToken` (random 256-bit, hashed at rest). Subsequent connections authenticate via `token`.

### Render delivery (at-least-once, FR-3.5)
| Frame | Direction | Payload |
|---|---|---|
| `render.new` | relay → plugin | `{ renderId, name, payloadUrl, assetBase, schemaVersion, bytes }` — `payloadUrl` is a short-lived signed Storage URL; plugin fetches JSON + assets itself (keeps WS frames tiny) |
| `render.ack` | plugin → relay | `{ renderId }` — payload fetched, build starting |
| `render.progress` | plugin → relay | `{ renderId, pct, stage: "fetching" | "building" }` (throttle ≥ 500ms) |
| `render.done` | plugin → relay | `{ renderId, rootNodeId, summary: { layers, rasterRegions, fontsSubstituted } }` |
| `render.failed` | plugin → relay | `{ renderId, error: { code, message } }` |

Redelivery: un-acked `render.new` is re-sent on reconnect and every 60s (max 10 attempts → status `failed`, error `delivery_timeout`). Plugin must treat `render.new` idempotently by `renderId` (FR-2.3: a re-imported id replaces the prior frame, never duplicates).

### Context round-trip (FR-2.6, FR-3.7)
| Frame | Direction | Payload |
|---|---|---|
| `context.request` | relay → plugin | `{ requestId, scope: "selection" \| "page", maxDepth: 6, maxNodes: 500 }` |
| `context.response` | plugin → relay | `{ requestId, context: { nodes: [ { id, name, type, x, y, w, h, fills?, text?, children? } ] } }` |

The context format is intentionally simple/lossy — it exists so an AI can *see* the canvas, not to round-trip designs.

## 7. Translation worker (`apps/worker`)

pg-boss consumer for `translate` jobs. Per job:

1. Load job → fetch HTML (kind `html` from Storage; kind `url` via the sandboxed page itself — never via Node fetch).
2. Launch/reuse Chromium (Playwright, one browser, fresh **context** per job; browser restarted every 50 jobs or on crash).
3. `page.setContent(html)` or `page.goto(url)`; viewport from request (default 1440×900, dpr 2); wait for `networkidle` (cap 15s) + `document.fonts.ready`.
4. Inject `capture-core` IIFE bundle (`page.addScriptTag`); call `window.__designbridge_capture()` → envelope + raster requests; rasterize via the in-page pipeline (same code path as extension).
5. Hash assets, presign + upload (skip dedup hits), write capture JSON to Storage, update render row (`status='delivering'`, timing), enqueue `deliver`.
6. Failure → `status='failed'` + error code (`render_timeout`, `nav_blocked`, `capture_error`, `asset_upload_failed`); always recorded, never silent.

**Sandbox hardening (FR-4.2, NFR-4) — all mandatory:**

- Worker container: no Supabase service key beyond Storage-write scope; read-only filesystem except `/tmp`; `cap_drop: ALL`; memory limit 1 GB, CPU 1.0, pids limit 256.
- Chromium launched with `--no-sandbox` **only if** container provides isolation (preferred: keep Chromium sandbox, run container with `seccomp=chrome.json`).
- Egress: all page traffic through a proxy filter (Playwright `route`) — allow `https:` only; resolve DNS and **block private/link-local/metadata ranges** (10/8, 172.16/12, 192.168/16, 127/8, 169.254/16, ::1, fd00::/8). Block `file:`, `data:` documents, redirects re-checked.
- Hard timeout 30s per job (kill page), 60s kill container watchdog.
- Concurrency: 2 jobs in parallel on beta hardware (8 GB VPS); pg-boss `teamSize: 2`.

## 8. MCP server (`apps/mcp`)

`@modelcontextprotocol/sdk`, Streamable HTTP transport at `https://mcp.designbridge.io/mcp`. Stateless; calls relay via `packages/client` with the caller's API key. Auth beta: `Authorization: Bearer db_live_...` (FR-5.2). OAuth 2.1 + DCR is P5 (FR-5.4) — design the auth layer as a strategy interface now.

```jsonc
// tool: send_to_figma  (FR-5.1)
{ "name": "send_to_figma",
  "description": "Render a design onto the user's Figma canvas. Provide complete standalone HTML (inline CSS or <style>; no external framework imports that need a build step).",
  "inputSchema": { "type": "object", "required": ["html"], "properties": {
      "html":     { "type": "string", "description": "Standalone HTML document" },
      "name":     { "type": "string", "description": "Frame name in Figma" },
      "viewport": { "type": "object", "properties": {
          "width": { "type": "number", "default": 1440 },
          "height": { "type": "number", "default": 900 } } } } } }
// → submits kind:"html", polls relay until terminal (timeout 60s),
//   returns { status, warnings[], figmaSummary } as tool result text.

// tool: get_figma_context  (FR-5.1)
{ "name": "get_figma_context",
  "description": "Read the user's current Figma selection or page as structured JSON.",
  "inputSchema": { "type": "object", "properties": {
      "scope": { "enum": ["selection", "page"], "default": "selection" } } } }
// → POST /v1/context, returns context JSON or a clear error
//   ("Figma plugin is not open — open the DesignBridge plugin in Figma").
```

Tool results must surface warnings verbatim so the calling AI can tell the user (NFR-2 zero-silent rule). Distribution: docs config snippet (beta) + Claude Code/Cowork plugin manifest in `apps/mcp/plugin/` (FR-5.3).

## 9. Client apps

### 9.1 Extension (`apps/extension`)
- `content.js` → thin wrapper importing `capture-core` bundle (build step via esbuild; output identical behavior — verified by `test/run-capture-tests.js`).
- New background service worker: receives capture from content script → hashes assets → presign+upload → `POST /v1/renders` → notifies content-script panel of status (poll `statusUrl`).
- Popup: key entry (stored `chrome.storage.local`, never synced), pairing-code entry → `POST /v1/pair`, channel selector, connection test.
- Panel v2 (FR-1.4): fidelity report + status timeline (captured → uploaded → delivered → built ✓) + clipboard-fallback button.
- Manifest additions: `host_permissions` += `https://relay.designbridge.io/*`, storage permission. No new content-script matches.

### 9.2 Figma plugin (`apps/figma-plugin`)
- `manifest.networkAccess.allowedDomains = ["https://relay.designbridge.io", "wss://relay.designbridge.io", "https://<supabase-project>.supabase.co"]`.
- WS client per §6 (note: WS runs in the plugin **UI iframe**; `code.ts` ↔ UI via `postMessage` — Figma plugin sandbox cannot open sockets).
- Builder: `figma-builder` package; chunked build loop yielding every 16ms budget (FR-2.3); progress → UI → WS.
- `figma.clientStorage`: `channelToken`, `renderId → nodeId` map (FR-2.7).
- Context responder per §6 (runs in `code.ts`, serializes via UI to WS).
- Retains paste-JSON textarea (FR-2.5).

### 9.3 Web (`apps/web`)
Next.js App Router on Vercel. Supabase Auth (magic link). Pages: `/` landing · `/docs/*` (setup guides, REST reference, MCP snippets) · `/dashboard` (keys CRUD — raw key shown once; usage chart from `renders`; pairing helper) · `/legal/privacy`, `/legal/terms`. Key generation server-side (Supabase Edge Function or route handler with service role): `db_live_` + 32 random base62 chars; store sha256 + prefix.

## 10. Infrastructure & deployment

`infra/docker-compose.yml` services: `caddy` (443/80, auto-TLS for relay.designbridge.io + mcp.designbridge.io) · `relay` · `mcp` · `worker` (Playwright base image `mcr.microsoft.com/playwright:v1.x-jammy`). Restart policy `unless-stopped`; healthchecks on each.

**Environment variables (server `.env`, never committed):**

| Var | Used by |
|---|---|
| `DATABASE_URL` (Supabase pooler, service role) | relay, worker |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | relay (presign), worker (storage-scoped key) |
| `STORAGE_BUCKET` (`designbridge-assets`) | relay, worker |
| `RELAY_PUBLIC_URL`, `MCP_PUBLIC_URL` | relay, mcp |
| `SENTRY_DSN_*` | all |
| `LOG_LEVEL` | all |

**CI/CD (GitHub Actions):** on PR → typecheck, lint, vitest, schema compat, capture/plugin harnesses, golden-corpus pixel-diff (Playwright + builder replay + pixelmatch; fail if any fixture < 99% or score regresses > 0.2pt). On main → build images → push GHCR → SSH deploy (`docker compose pull && up -d`) → smoke test `/v1/health` + one synthetic render → rollback to previous tag on failure.

**Monitoring:** pino JSON logs (request id propagated sender→relay→worker→plugin via `renderId`) · Sentry all surfaces · UptimeRobot on `/v1/health` · daily metric: renders, success rate, p50/p95 timing (SQL over `renders.timing`).

## 11. Testing strategy

| Layer | Tool | Gate |
|---|---|---|
| Schema validation + compat | vitest | CI |
| capture-core regression | existing `test/run-capture-tests.js` (32 assertions) | CI |
| figma-builder regression | existing `test/run-plugin-tests.js` (stubbed Figma API) | CI |
| Relay REST | vitest + injected Fastify, real Postgres (Supabase branch DB) | CI |
| WS protocol | vitest: scripted fake plugin client vs relay (pairing, redelivery, idempotency, context timeout) | CI |
| Worker pipeline | integration: fixture HTML → worker → capture JSON deep-equal vs extension capture of same fixture (**the two paths must agree**) | CI |
| Pixel fidelity | golden corpus (10–20 fixtures) → pixelmatch ≥ 99% | CI release gate |
| E2E (manual, pre-release) | J1/J2/J3 journeys on staging | release checklist |
| Security | SSRF probe suite vs worker (metadata IP, private ranges, redirects, file:), pairing brute-force test | CI |

## 12. Security checklist (release gate, PRD §8.4)

- [ ] API keys: 256-bit random, sha256 at rest, shown once, revocable; no keys in logs.
- [ ] Pairing: single-use, 10-min TTL, charset excludes ambiguous chars, rate-limited + lockout per §5.
- [ ] Channel tokens: 256-bit, hashed at rest, revocable from dashboard.
- [ ] Worker SSRF suite green; egress allowlist verified; container caps applied.
- [ ] All endpoints HTTPS/WSS; HSTS via Caddy; CORS: relay allows extension origin + designbridge.io only.
- [ ] Zod validation on every REST body and WS frame (malformed frame → `error` + close, never crash).
- [ ] Payload/asset size limits enforced (§5); Storage bucket private, signed URLs ≤ 10 min.
- [ ] RLS deny-by-default; web app sees own rows only; service role confined to servers.
- [ ] Dependency audit (`pnpm audit`) clean of criticals; Docker images pinned by digest.
- [ ] Rollback procedure documented in `docs/runbooks/deploy.md` and tested once.

## 13. Build phases — task breakdown with acceptance criteria

Sized for one engineer/agent; each task lists **AC** (acceptance criteria). Do not start a phase before the prior phase's AC pass. Track B (fidelity, `IMPROVEMENT-PLAN.md` sprints 2–5) interleaves continuously and is not repeated here.

### Phase 0 — Monorepo & shared packages (FR-7)
- **T0.1** pnpm workspace scaffold, TS configs, eslint/prettier, vitest, CI skeleton. *AC: `pnpm -r build && pnpm -r test` green in CI.*
- **T0.2** `packages/schema`: zod envelope (§3), validator, version utils, fixture validation tests. *AC: all existing fixtures validate; compat test in CI.*
- **T0.3** `packages/capture-core`: move `content.js` verbatim; esbuild IIFE + ESM outputs; expose `__designbridge_capture()`. *AC: `run-capture-tests.js` green against the bundle.*
- **T0.4** `packages/figma-builder`: move `code.js` builder logic; plugin entry consumes it. *AC: `run-plugin-tests.js` green.*
- **T0.5** Rebuild extension + plugin from packages. *AC: manual smoke — capture + paste import behave identically to pre-refactor.*

### Phase 1 — Relay MVP + wiring (FR-3.1–3.6 core, FR-1.2/1.3, FR-2.1–2.5)
- **T1.1** Migrations §4 applied; pg-boss initialized. *AC: migration idempotent on fresh Supabase branch.*
- **T1.2** Relay: auth middleware, rate limiting, `POST/GET /v1/renders` (capture kind only), `/v1/health`. *AC: REST tests green incl. all error codes.*
- **T1.3** WS hub + pairing per §6. *AC: scripted-client tests: pair, reconnect-with-token, redelivery, idempotent ack.*
- **T1.4** Plugin: WS client in UI iframe, pairing UI, render fetch→build→ack with progress. *AC: J1 steps 2–5 work against local relay.*
- **T1.5** Extension: background submit + popup (key, pairing) + clipboard fallback. *AC: claude.ai → Figma live render end-to-end; pull relay down → fallback path works.*
- **T1.6** Offline queue. *AC: submit while plugin closed → open plugin → render arrives exactly once.*

### Phase 2 — Assets + translation worker (FR-4, FR-1.4, NFR-1)
- **T2.1** `/v1/assets/presign` + content-addressed Storage + dedup + GC cron. *AC: duplicate asset uploads skipped; GC removes orphans in test.*
- **T2.2** Extension/plugin switch to externalized assets. *AC: 10 MB raster design transfers; WS frames stay < 10 KB.*
- **T2.3** Worker per §7 incl. sandbox + egress filter. *AC: fixture HTML → layers in Figma; SSRF probe suite green; 30s timeout enforced.*
- **T2.4** `html`/`url` kinds in `POST /v1/renders`. *AC: J3 (curl) passes; worker capture deep-equals extension capture on shared fixtures.*
- **T2.5** Capture panel v2 + plugin import summary. *AC: warnings from a degraded fixture visible in both UIs.*

### Phase 3 — MCP server (FR-5.1–5.3)
- **T3.1** MCP server + `send_to_figma` per §8. *AC: from Claude Code with config snippet, prompt → design on canvas; warnings in tool result.*
- **T3.2** Context round-trip: relay `/v1/context` + plugin responder + `get_figma_context`. *AC: selection summary returned < 3s; plugin-closed → clear error.*
- **T3.3** Plugin manifest + docs for Cowork/Claude Code/Codex. *AC: J2 passes from a clean machine following docs only.*

### Phase 4 — Web, hardening, beta launch (FR-6.1–6.4, §12)
- **T4.1** designbridge.io: landing, auth, instant key, dashboard, pairing helper, docs, legal. *AC: new user completes J1 setup ≤ 10 min using only the site.*
- **T4.2** Security checklist §12 complete. *AC: every box checked, evidence linked.*
- **T4.3** Monitoring + runbooks + tested rollback. *AC: synthetic render alert fires on induced failure.*
- **T4.4** Store submissions (Chrome Web Store, Figma Community). *AC: submitted; dev-install docs published as bridge.*
- **T4.5** Beta gate: PRD §8 release criteria reviewed. *AC: all criteria met → launch.*

### Phase 5 — Post-beta (FR-5.4, FR-2.8/5.5, FR-6.5)
OAuth 2.1 + Claude directory submission · `update_figma_design` (render-id node mapping → in-place replace) · Stripe billing on the existing usage data · SSE status streaming · capture adapters for other tools.

---

*End of spec. Questions or ambiguities discovered during build: record them in `docs/DECISIONS.md` with the chosen resolution rather than guessing silently.*
