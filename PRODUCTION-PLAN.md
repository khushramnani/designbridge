# DesignBridge — Production Build Plan

**Vision:** User talks to any AI → design appears on their Figma canvas as editable layers.
**Decisions locked (2026-06-12):** deterministic translation (headless render + capture engine, no LLM in hot path) · self-hosted VPS + Supabase · full product scope · free beta first, billing later.

---

## 1. Revised architecture — 4 components, not 5

Your "MCP Server" and "Claude Integration Plugin" are the **same artifact**: one remote MCP server, distributed two ways (manual config for power users; Claude connectors directory via OAuth for everyone). Merging them removes an entire build phase.

```
ENTRY POINTS                          BACKEND (your VPS)                 OUTPUT
┌──────────────────┐
│ Chrome Extension  │──capture JSON──┐
│ (claude.ai)       │                │   ┌──────────────────────────┐
└──────────────────┘                 ├──▶│ RELAY SERVER             │
┌──────────────────┐                 │   │  REST + WebSocket        │    ┌──────────────┐
│ MCP Server        │──HTML/JSON────┤   │  pairing · auth · queue  │───▶│ FIGMA PLUGIN │
│ (Cowork/CLI/      │                │   │  usage tracking          │ WS │  WS client   │
│  claude.ai via    │                │   ├──────────────────────────┤    │  builder     │
│  connectors dir)  │                │   │ TRANSLATION WORKER       │    │  context     │
└──────────────────┘                 │   │  headless Chromium       │    │  responder   │
┌──────────────────┐                 │   │  runs capture-core       │    └──────────────┘
│ Anything else     │──REST API─────┘   │  → same capture JSON     │
│ (curl, scripts)   │                    └──────────────────────────┘
└──────────────────┘                     Supabase: Postgres (keys, channels,
                                         renders, usage) + Storage (assets)
```

**The key insight:** your `content.js` capture engine (rendered DOM + `getComputedStyle` + confidence model) is the moat. The translation layer is NOT "ask Claude API to convert HTML" — it's *the same capture engine running in headless Chromium on the server*. Deterministic, ~1–2s, near-zero marginal cost, and every fidelity fix benefits both the extension and the server path because they share one library.

No LLM anywhere in the pipeline for beta. Senders must provide standalone HTML (the MCP tool schema enforces this — any AI calling `send_to_figma` can produce it). Post-beta, if demand appears, a normalizer pre-pass for non-HTML input (React source, screenshots) can be added as an opt-in where users plug in their own AI/API key — never in the default path.

---

## 2. Monorepo restructure (Phase 0 — do this first)

Today: `extension/content.js` (506 lines) and `figma-plugin/code.js` (690 lines) are standalone files. The moment the server also captures and a second sender speaks the protocol, copy-paste divergence kills you. Restructure:

```
designbridge/
├── packages/
│   ├── schema/          # THE CONTRACT. JSON Schema + TS types + validators.
│   │                    # Versioned (semver). Everything imports this.
│   ├── capture-core/    # content.js logic as a buildable lib (esbuild → IIFE
│   │                    # bundle). Consumed by: extension, translation worker.
│   ├── figma-builder/   # code.js builder logic as a lib. Consumed by: plugin,
│   │                    # test harness (stubbed Figma API).
│   └── client/          # tiny TS SDK for the relay REST API (used by
│                        # extension, MCP server, future CLI)
├── apps/
│   ├── extension/       # Chrome MV3 (thin shell around capture-core)
│   ├── figma-plugin/    # plugin shell: WS client + UI + figma-builder
│   ├── relay/           # Fastify + ws — REST, WS hub, pairing, auth, queue
│   ├── worker/          # translation worker — Playwright + capture-core
│   ├── mcp/             # MCP server (Streamable HTTP) → calls relay
│   └── web/             # designbridge.io — Next.js on Vercel
├── test/                # golden corpus + pixel-diff harness (extends current)
└── docker-compose.yml   # relay + worker + caddy on the VPS
```

Tooling: pnpm workspaces + TypeScript + esbuild. Migrate `content.js`/`code.js` to TS incrementally (start by wrapping as-is, add types as you touch code). CI (GitHub Actions): typecheck, unit tests, capture/plugin test harness, schema compat check on every PR.

---

## 3. The schema — versioned capture contract

The current capture JSON (`version: "0.6.0"`) becomes **schema v1**. With 3+ senders and 1 receiver, this is the most important interface in the product.

```jsonc
{
  "schemaVersion": "1.0.0",          // semver; plugin rejects major mismatch with clear msg
  "source": { "kind": "extension" | "server-render" | "direct", "tool": "claude-design", "url": "..." },
  "capturedAt": "...",
  "viewport": { "width": 1440, "height": 900, "dpr": 2 },
  "root": { /* node tree — current format, unchanged */ },
  "assets": [                         // NEW: no more inline base64 in the tree
    { "id": "sha256:abc...", "kind": "raster" | "image" | "font", "mime": "image/png",
      "bytes": 123456, "url": "https://<supabase-storage>/..." }
  ],
  "fonts": [ { "family": "Inter", "weights": [400,700], "matched": "Inter" } ],
  "warnings": [ { "code": "raster-region", "nodeId": "...", "detail": "..." } ]
}
```

Rules: nodes reference assets by id; assets are content-addressed (sha256) and deduped; uploaded to Supabase Storage via presigned URLs; the JSON body stays small (target <1 MB) even when rasters are huge. This solves Tier 5.1 (clipboard/payload choke) permanently. `additive minor / breaking major` versioning; plugin and relay both validate with the shared validator; capture-plugin compat tested in CI against fixture matrix.

---

## 4. Component specs

### 4.1 Relay server (`apps/relay`) — Node 22 + TS, Fastify + `ws`

**REST (senders):**
- `POST /v1/renders` — body: `{ channel, payload: { kind: "capture" | "html" | "url", ... } }`. `capture` → enqueue for delivery; `html`/`url` → enqueue for translation worker first. Returns `render_id`.
- `GET /v1/renders/:id` — status: `queued | translating | delivering | done | failed` + warnings + (later) preview thumbnail.
- `POST /v1/assets/presign` — presigned Supabase Storage upload URLs (extension uploads rasters directly; relay never proxies blobs).
- `POST /v1/pair` — claim a pairing code → binds API key ↔ figma channel.
- `GET /v1/health`.

**WebSocket (plugin):** `wss://relay.designbridge.io/v1/ws?token=...`
Frames: `hello`, `render.new`, `render.ack`, `render.progress`, `render.done`, `context.request`, `context.response`, `ping/pong`.

**Pairing flow (security-critical):**
1. Plugin connects unauthenticated → relay issues channel + 6-char code (TTL 10 min, single-use, rate-limited per IP).
2. User enters code once in extension popup / MCP setup / dashboard.
3. Relay binds API key ↔ channel, issues the plugin a long-lived channel token (revocable from dashboard). Codes never reusable; brute-force lockout.

**Delivery semantics:** at-least-once. Renders persist in Postgres; if plugin offline, queued and pushed on reconnect; plugin acks; idempotency by `render_id` (re-import replaces, not duplicates). `context.request` is a round-trip with 15s timeout (this is how `get_figma_context` works — the plugin is the only thing that can read the canvas live).

**Auth & usage:** API keys `db_live_...`, stored hashed (SHA-256), per-key rate limits (token bucket), every render logged to `renders` table (key, channel, kind, bytes, duration, status) — this is the usage-tracking hook billing plugs into later. Anonymous keys for free beta: issued instantly on designbridge.io with generous limits (e.g. 100 renders/day).

**Supabase tables:** `api_keys`, `channels`, `pairings`, `renders`, `assets`, `users` (beta: optional email). Queue: **pg-boss** on the same Supabase Postgres (skip Redis — fewer moving parts on one VPS; revisit if >5 renders/s sustained).

### 4.2 Translation worker (`apps/worker`) — the deterministic translation layer

```
HTML / URL in  →  sandboxed Chromium (Playwright)  →  inject capture-core bundle
              →  capture JSON + raster PNGs  →  upload assets  →  enqueue delivery
```

- Runs as a separate Docker container (Playwright base image), polls pg-boss.
- Renders at a standard viewport (1440×900, dpr 2; sender can override).
- **Sandbox hardening (you are rendering arbitrary HTML):** dedicated container, no env secrets, egress proxy that blocks private IP ranges (SSRF), allowlisted protocols (https only), 30s render timeout, 512 MB / 1 CPU limits, page closed after every job, container restarted periodically.
- Webfonts/images: page loads them naturally (this *fixes* the extension's cross-origin raster problem for the server path — Tier 2.1/2.2 come free here).
- Input is standalone HTML or a URL only (beta). No LLM pre-pass — deferred post-beta as an opt-in, user-supplied-key feature if demand appears.

### 4.3 MCP server (`apps/mcp`) — one server, two distributions

Remote MCP (Streamable HTTP) at `https://mcp.designbridge.io`. Thin: validates input, calls relay via `packages/client`, streams progress.

Tools:
- `send_to_figma({ html | url | capture_json, name?, viewport? })` → renders to the paired channel; returns render status + warnings. (AI passes the HTML it just generated.)
- `get_figma_context({ scope: "selection" | "page" })` → relay round-trips to plugin → returns simplified node JSON so the AI can see what's on canvas before designing.
- `update_figma_design({ node_id, html })` → v2; replaces a previously imported frame in place (plugin tracks `render_id → node` mapping).

Auth phases: **(a)** API key header — works day one in Claude Code/Cowork/Codex custom MCP config. **(b)** OAuth 2.1 (PKCE + dynamic client registration) — required for the Claude connectors directory; Supabase Auth as the IdP. Also ship a Claude Code/Cowork **plugin manifest** wrapping the remote server (one-command install) — that's the whole "component 5".

### 4.4 Chrome extension upgrades

- Background service worker: `POST /v1/renders` with capture JSON; assets via presigned upload. **Clipboard stays as fallback** (offline / not paired).
- Popup: API key + pairing code entry, connection status, default channel.
- Capture panel v2: fidelity report (N layers, N rasterized regions + why, font substitutions, size warnings) instead of raw JSON dump.
- Robustness (Tier 5.4): MutationObserver re-shows button on iframe re-render; multiple artifacts per page; schemaVersion stamped.
- Store-readiness: MV3, no remote code (capture-core bundled at build), minimal permissions, privacy policy page on designbridge.io.

### 4.5 Figma plugin upgrades

- WS client with exponential-backoff reconnect; `networkAccess.allowedDomains: ["https://relay.designbridge.io", "wss://relay.designbridge.io"]` (replaces `"none"`).
- Pairing UI: shows code, connection state (connected / receiving / done), render queue with progress.
- Chunked build (yield via `setTimeout`) so big imports don't freeze Figma; import summary + warnings; "replace previous import" using stored `render_id` mapping.
- Context responder: serialize selection/page (bounds, fills, text, names) for `get_figma_context`.
- Schema version check → human-readable "please update the plugin" message.
- Keep paste-JSON textarea as the no-backend fallback path.

### 4.6 designbridge.io (`apps/web`) — Next.js on Vercel

Beta scope only: landing page, sign-in (Supabase Auth, email magic link), instant API key, pairing helper, usage dashboard (reads `renders`), docs (extension setup, plugin setup, MCP config snippets), privacy/ToS. Stripe + plans deferred until there's real usage — but the `renders` table and per-key limits mean turning billing on is config, not engineering. Figma OAuth is **not needed for v1** (the plugin does all canvas writes); add it later only if you want REST-API features (file thumbnails, export-based pixel-diff in CI).

---

## 5. VPS deployment

```
docker-compose:  caddy (TLS, reverse proxy)  →  relay :8080  |  worker (pg-boss poller)
```

- Caddy auto-TLS for `relay.designbridge.io` + `mcp.designbridge.io` (mcp can run inside relay process initially; split when load demands).
- VPS sizing: 4 vCPU / 8 GB handles WS hub + ~2 concurrent Chromium renders comfortably. WS is cheap (10k+ idle connections fine); Chromium is the constraint — queue absorbs bursts.
- Ops: GitHub Actions → build images → SSH deploy (or Watchtower); pino structured logs; Sentry (relay + worker + plugin UI + extension); UptimeRobot on `/v1/health`; Supabase handles DB backups.
- Single VPS is a single point of failure — acceptable for beta; the stateless relay + Postgres-backed queue means scaling later = add a second node + load balancer, no redesign.

---

## 6. Build phases

Two parallel tracks. **Track A = product infra (new). Track B = fidelity (existing IMPROVEMENT-PLAN sprints 2–5) — this stays alive because rendering quality IS the product; infra is plumbing.** The pixel-diff harness (Tier 4) is the regression gate for both.

| Phase | Scope | Done when |
|---|---|---|
| **0** (wk 1) | Monorepo + pnpm + TS scaffolding; extract `schema`, `capture-core`, `figma-builder`; CI green with existing 32 assertions | Extension & plugin rebuilt from packages, behavior identical |
| **1** (wk 2–3) | Relay MVP: pairing, WS hub, `POST /v1/renders` (capture kind), Postgres persistence, offline queue. Wire extension (relay mode + clipboard fallback) and plugin (WS + pairing UI) | Click button on claude.ai → design appears live in Figma, plugin offline-queue works |
| **2** (wk 3–4) | Asset offload (presigned uploads, content-addressed); translation worker (sandboxed Chromium + capture-core); `html`/`url` render kinds; capture panel v2 + plugin progress UI | `curl` posts raw HTML → editable layers in Figma; multi-MB designs transfer reliably |
| **3** (wk 4–5) | MCP server: `send_to_figma` + `get_figma_context` (context round-trip protocol in relay + plugin responder); API-key auth; config docs + plugin-manifest install for Cowork/Claude Code/Codex | "design a dashboard on my figma" in Cowork → appears on canvas |
| **4** (wk 5–7) | designbridge.io beta (auth, instant keys, usage dashboard, docs); rate limits + abuse hardening; Sentry/monitoring; submit Chrome Web Store + Figma Community | Free beta open; strangers can self-serve end-to-end |
| **5** (wk 7–9) | OAuth 2.1 on MCP → Claude connectors directory submission; `update_figma_design`; Stripe when usage justifies | Installed from Claude integrations page; works on claude.ai natively |
| **B** (continuous) | Sprint 2: Tier 1.10–12 + Tier 2 raster quality · Sprint 3: panel v2 polish · Sprint 4: Auto Layout v2 (validate-or-fallback) · Sprint 5: Variables, Components, semantic names | ≥99% pixel match on golden corpus, zero silent degradations |

---

## 7. Risks & mitigations

1. **Anthropic ToS (extension reads claude.ai previews).** Reads only the user's own currently-viewed design — but get this reviewed before public launch. Mitigation: the MCP path doesn't touch claude.ai at all and the worker renders AI-handed HTML; if the extension path is ever challenged, the product survives on MCP alone.
2. **Rendering arbitrary HTML = abuse surface.** SSRF blocks, egress allowlist, container isolation, timeouts, per-key rate limits (§4.2). Treat the worker as hostile-input territory from day one.
3. **Store reviews** (Chrome Web Store, Figma Community, Claude directory) take weeks and can bounce. Submit early in Phase 4/5; keep dev-install instructions as the bridge.
4. **Schema drift** across 3 senders + 1 receiver. Mitigated by the shared `schema` package, semver gating, and CI compat tests — this is why Phase 0 is first.
5. **Single-VPS outage.** Plugin falls back to paste-JSON; extension falls back to clipboard. The product degrades to today's working state, never to zero.
6. **Fidelity stagnation.** If Track B stalls, you ship a fast pipe for mediocre imports. The pixel-diff score stays the north-star metric; block releases that regress it.

## 8. Success metrics (beta)

Pipeline p50 < 5s (capture submit → layers on canvas) · ≥99% pixel match on golden corpus · render success rate >97% · zero silent degradations (every compromise = a surfaced warning) · time-to-first-render for a new user < 10 min from install.
