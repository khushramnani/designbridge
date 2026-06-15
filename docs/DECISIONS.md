# DesignBridge — Build Decisions Log

Per TECHNICAL-SPEC: ambiguities discovered during the build are recorded here with the
chosen resolution rather than guessed silently.

---

## D1 — Relay data + queue layer behind an interface (2026-06-13)

**Context.** TECHNICAL-SPEC §4/§7 target Supabase Postgres + pg-boss. The contract logic
(REST error codes, pairing rules, WS delivery semantics) is what Phase 1 must get right, and
TESTING-STRATEGY §11 wants those tested in CI. No Supabase credentials exist in the build
environment yet, and CI must run without an external DB.

**Decision.** The relay accesses persistence through a `Store` interface and queuing through a
`Queue` interface. Phase 1 ships an in-memory implementation of both (default for local dev and
CI). A Postgres/pg-boss implementation lands behind the same interfaces when credentials are
provisioned (Phase 1 T1.1 against a Supabase branch DB) — no relay logic changes.

This mirrors the spec's own pattern for rate limiting ("in-memory behind an interface so Redis
can replace it when multi-node", §5) and keeps the WS/REST contract tests hermetic.

**Consequence.** `RELAY_STORE=memory` (default) or `postgres`. In-memory store is non-persistent
— a relay restart drops queued renders; acceptable for dev, never for prod. The Postgres impl is
the production target and the only one that satisfies FR-3.5 (durable offline queue).

## D2 — WS transport library (2026-06-13)

**Context.** Spec §1 says "Fastify + ws". Two integration options: raw `ws.Server` attached to
Fastify's HTTP server, or `@fastify/websocket`.

**Decision.** `@fastify/websocket` (wraps `ws`) so the WS endpoint participates in Fastify's
lifecycle/logging and shares the same server. The hub logic is transport-agnostic (operates on a
minimal socket interface) so it stays unit-testable.

## D3 — Render payloads in Postgres (text) for Phase 1 (2026-06-13)

**Context.** TECHNICAL-SPEC §5/§9 externalize assets and capture JSON to Supabase Storage
(`renders.payload_path`), but asset offload is Phase 2 (T2.1/T2.2). Phase 1 still needs the plugin
to fetch a render's capture JSON.

**Decision.** Phase 1 stores the capture JSON in a `render_payloads(render_id, body text)` table and
serves it from `GET /v1/renders/:id/payload?t=<token>` (the signed-URL stand-in). `renders.payload_path`
stays in the schema, unused, ready for Phase 2 to switch `putPayload`/`getPayload` to Storage and
point `render.new.payloadUrl` at a real signed URL — no plugin/relay protocol change.

**Consequence.** Inline rasters (`imgData`) live in the JSON in Phase 1, so payloads can be large;
the §5 100 KB inline cap stays permissive until presign lands (`maxInlineBytes`, app.ts).

## D4 — PostgresStore tested via pg-mem; `api_keys.user_id` nullable (2026-06-13)

**Context.** No Supabase credentials in the build env; CI must stay hermetic (D1). The PostgresStore
still needs to be exercised, not just typechecked.

**Decision.** `test/store-contract.test.ts` runs ONE contract suite against both `InMemoryStore` and
`PostgresStore` (backed by `pg-mem`, an in-process Postgres — `gen_random_uuid` registered, real
DDL from `migrations/0001_init.sql`). The suite caught two real bugs: a missing `users` row for
seeded keys (so `api_keys.user_id` is **nullable** — anonymous beta/dev keys carry `userId: null`)
and an unclaimed-pairing field returning `undefined` vs `null`. Externally-reachable reads
(`getRender`/`getPayload`) guard against non-uuid path params (return null, not a 500).

**Consequence.** Real-Supabase validation (run `migrations/0001_init.sql` on a branch DB, boot with
`RELAY_STORE=postgres DATABASE_URL=…`) is pending credentials; pg-mem covers SQL correctness in CI.

## D5 — Storage + Queue abstractions; worker runs in-process for dev/CI (2026-06-13)

**Context.** Phase 2 needs content-addressed asset storage (Supabase Storage) and a relay↔worker job
queue (pg-boss on Supabase Postgres). Neither has credentials in the build env, and the worker is a
separate container in prod but must be testable end-to-end in CI.

**Decision.** Same pattern as the Store (D1): `Storage` and `Queue` interfaces with in-memory impls
(`apps/relay/src/storage`, `.../queue`) for dev/CI; Supabase Storage + pg-boss are the production
targets behind the same interfaces. The worker (`apps/worker`) depends only on minimal structural
capability interfaces (`WorkerStore`/`WorkerStorage`/`WorkerQueue`) — no app→app coupling — so the
integration test wires the relay's concrete impls into the worker in one process. Asset blobs are
served from the relay (`GET /v1/assets/:hash`, content-addressed, ACAO `*`) as the Storage signed-URL
stand-in; prod swaps `render.new.assetBase` to Storage URLs.

**Consequence.** The standalone worker entry (`apps/worker` `start`) is a placeholder until pg-boss +
Supabase Storage clients land; today the worker is exercised in-process (real Chromium) by
`apps/relay/test/worker-e2e.test.ts`. Browser tests need `chromium.launch()` — CI installs full
chromium (not just headless-shell). Deployment infra (Dockerfiles, compose with §7 worker hardening:
`cap_drop: ALL`, seccomp, mem/cpu/pids limits, read-only fs) is the remaining Phase 2 work.

## D6 — MCP server (Phase 3) and web app (Phase 4) reuse the relay's persistence + key-gen (2026-06-14)

**Context.** Phase 3's MCP server and Phase 4's web dashboard both need to act on the same data the
relay owns: the MCP server submits renders / reads context as a caller's API key; the web app issues,
lists, revokes API keys and reads render usage. Re-deriving key format (`db_live_` + 32 base62,
sha256 hash, 12-char prefix) or the `api_keys`/`renders`/`users` schema in another component would be
exactly the copy-paste drift Phase 0 was built to prevent.

**Decision.** Both reuse the relay package as the single source of truth. `apps/relay/src/index.ts`
re-exports `buildApp`, `Hub`, `InMemoryStore`, `PostgresStore`/`runMigrations`, the id helpers
(`generateApiKey`/`keyPrefix`/`sha256`/`uuid`), and the store types. The **MCP server** is stateless
Streamable HTTP and talks to the relay over REST via `packages/client` (no DB access of its own —
clean process boundary, matches §8). The **web app** shares the relay's `Store` directly
(`InMemoryStore` for dev/CI, `PostgresStore` for prod against the same Supabase DB), with account
logic (`apps/web/src/lib/accounts.ts`) layered on top. The `Store` interface gained additive
user/key/usage methods (`getUserByEmail`, `createUser`, `getApiKeyById`, `getApiKeysForUser`,
`revokeApiKey`, `getDailyRenderCounts`) implemented by both stores and covered by the dual-store
contract test.

**Consequence.** Keys minted by the dashboard validate on the relay with zero format coupling. Usage
day-bucketing is done in application code (not SQL `AT TIME ZONE`, which pg-mem lacks) — UTC-correct
and portable; fine for beta per-user volumes. The web app currently ships the tested account
foundation (`accounts.ts` + 8 tests); the Next.js UI (auth, dashboard, docs, legal) and abuse
hardening are the remaining Phase 4 slices.

## D7 — Big-render reliability: chunked build, live progress, idempotent re-import (2026-06-14)

**Context.** Large imports (e.g. a ~150-layer landing page) appeared to "drop the connection" mid-
render. Root cause: the Figma builder imported the whole tree in ONE synchronous `build()` pass,
pegging the plugin main thread so it couldn't answer `context.request`/heartbeats (so the calling AI
saw context reads fail and assumed a disconnect), often ran past `send_to_figma`'s 60s timeout, and
gave no progress. FR-2.3's "chunked build loop" had never been implemented.

**Decision.**
1. **Chunked, yielding build** (`packages/figma-builder`): `build()` is now async and yields to the
   event loop every ~12ms (`setTimeout(0)`), keeping Figma responsive during big imports. It posts
   `{type:"progress", count, total}` to the UI as it goes. The plugin test harness already
   `await`ed `onmessage`, so no harness change was needed.
2. **Live progress, no DB churn**: plugin UI forwards build progress as `render.progress` (frame
   extended with `count`/`total`); the relay Hub keeps the latest progress **in memory** (`getProgress`,
   cleared on done/failed) and `GET /v1/renders/:id` merges it — no per-tick DB writes.
3. **Honest `send_to_figma`**: timeout raised to 180s; once a render is seen `delivered`/has progress,
   a later timeout reports "reached Figma, still building (~N/M layers) — not a disconnect" instead of
   falsely implying a dropped connection.
4. **Idempotent re-import** (FR-2.7): the plugin passes `renderId` into the builder, which stamps the
   root frame (`setPluginData("db_render_id")`) and removes any prior frame with the same id before
   appending — so redelivery/retry REPLACES rather than duplicating.

**Consequence.** Big pages build without freezing Figma and surface progress; retries don't duplicate.
Splitting very tall pages into sections (worker/MCP-side) remains a future enhancement (#4 in the
plan), not yet done. Tests: builder harness still 19/19; relay progress round-trip + MCP
"still-building" messaging covered. Requires re-importing the plugin and restarting the relay.

## D8 — Phase 4 web app slice 2: Next.js UI over the shared AccountService (2026-06-15)

**Context.** Slice 1 (D6) left `apps/web` as framework-free logic only (`AccountService` + tests).
Slice 2 turns it into the real designbridge.io beta site: landing, magic-link auth, dashboard
(keys + usage + pairing), docs, and legal pages.

**Decision.**
1. **Next.js 15 (App Router) + React 19** in `apps/web`. `build`=`next build`, `typecheck`=`tsc
   --noEmit`. The repo's single root ESLint flat config owns linting (`next.config` sets
   `eslint.ignoreDuringBuilds`); a new `apps/web/**/*.{ts,tsx}` block adds browser+node globals and
   turns off `no-undef` (tsc checks JSX types) — mirrors the extension/plugin glue block.
2. **One import convention.** The monorepo uses NodeNext `.js` specifiers pointing at `.ts` sources.
   Next/webpack doesn't resolve that by default, so `next.config` sets `resolve.extensionAlias`
   (`.js`→`.ts`/`.tsx`). Keeps web consistent with every other package + how vitest already resolves.
3. **Supabase Auth (magic-link)** via `@supabase/ssr`: server client over cookies, browser client for
   the sign-in form, `/auth/callback` exchanges the code, middleware refreshes the session. All env
   access is lazy/guarded (`supabaseConfigured()`, inert placeholders) so `next build` never needs
   secrets and the app degrades to "auth not configured" instead of crashing.
4. **Shared store, lazily built.** `getStore()` mirrors the relay's `createStore` (in-memory default,
   `WEB_STORE=postgres` + `DATABASE_URL` for prod — same DB as the relay, D6). Constructed on first
   request, never at module load, so build doesn't need a database. `pg`/`@types/pg` are now direct
   web deps (kept external from the Next bundle via `serverExternalPackages`).
5. **Testable HTTP layer.** Request/response logic lives in framework-free builders (`src/lib/api.ts`)
   that take the service + userId and return web-standard `Response`s, mapping `AccountError` →
   409/404/403 and unauth → 401. App Router route handlers (`/api/keys`, `/api/keys/[id]`,
   `/api/usage`) are a thin auth shell over them. 10 new hermetic vitest tests, no Next runtime.

**Consequence.** `next build` is green (13 routes), repo typecheck + lint clean, web tests 8→18, full
suite 143 green. **Still slice-3 (next):** abuse hardening (§12), Sentry/monitoring, Chrome Web
Store + Figma Community submissions. **Pending deploy/verify (needs creds):** real Supabase project
+ env, Vercel deploy, live magic-link sign-in, dashboard against the shared Postgres.
