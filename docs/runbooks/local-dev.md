# Runbook — local dev & manual J1 verification

End-to-end loop on one machine: Chrome extension → relay → Figma plugin.

> pnpm isn't on PATH on the current Windows box — run it via `npx --yes pnpm@9.15.4 …`
> (corepack lacks write perms to the Node install dir). See the memory note `pnpm-invocation`.

## 0. One-command local backend (no Supabase / VPS)

```
npx --yes pnpm@9.15.4 install
npx --yes pnpm@9.15.4 -r build
npx --yes pnpm@9.15.4 dev        # → node scripts/dev-stack.mjs
```

`dev` runs the **relay + translation worker (in-process Chromium) + MCP server** in one process
against the in-memory store, and prints a seeded `db_live_…` API key plus copy-paste next steps:

- relay `http://127.0.0.1:8088` (health `/v1/health`)
- mcp `http://127.0.0.1:8089/mcp` (health `/health`)

Env: `RELAY_PORT`, `MCP_PORT`, `HOST`, `DEV_API_KEY` (stable key across restarts),
`NO_WORKER=1` (skip Chromium — capture + `get_figma_context` still work; html/url renders won't
translate). Fastest path to test **all three** entry points (extension capture, MCP `send_to_figma`,
raw HTML) locally; then pair a Figma plugin (steps 3–4 below). In-memory store is non-durable — a
restart drops state and the pairing (docs/DECISIONS.md D1).

> Verified end-to-end 2026-06-14: WS pair → `POST /v1/renders` (html) → Chromium translate (~0.8s)
> → delivered → plugin built → status `done`.

The steps below are the same loop run à la carte (e.g. to run only the relay).

## 1. Build everything

```
npx --yes pnpm@9.15.4 install
npx --yes pnpm@9.15.4 -r build
```

Artifacts:

- `apps/extension/dist/` — load-unpacked Chrome extension
- `apps/figma-plugin/dist/` — `manifest.json` to import in Figma

## 2. Start the relay (in-memory store, dev key seeded)

```
PORT=8088 RELAY_PUBLIC_URL=http://localhost:8088 RELAY_DEV_SEED=1 node apps/relay/dist/index.js
```

It prints a `db_live_…` API key once. `GET http://localhost:8088/v1/health` should return `{ ok: true }`.
(In-memory store is non-durable — restarting drops queued renders; see docs/DECISIONS.md D1.)

## 3. Figma plugin

1. Figma desktop → Plugins → Development → **Import plugin from manifest** → `apps/figma-plugin/dist/manifest.json`.
2. Run it. The UI connects to `http://localhost:8088` (editable in the **Relay** field) and shows a **6-char pairing code**.

## 4. Chrome extension

1. `chrome://extensions` → enable Developer mode → **Load unpacked** → `apps/extension/dist`.
2. Click the toolbar icon → set **Relay URL** = `http://localhost:8088`, paste the seeded **API key**, Save.
3. Enter the plugin's **pairing code** → **Pair with Figma**. The plugin UI flips to "Paired ✓".

## 5. Capture → canvas

Open a Claude Design artifact (`*.claudeusercontent.com`), click **⬡ Send to Figma**. The design
builds live on the Figma canvas. If the relay is down or unpaired, the extension falls back to
clipboard + the plugin's "Offline fallback — paste capture JSON".

## J3 — REST / MCP path (raw HTML → Figma, via the translation worker)

The worker renders HTML/URL headlessly (Playwright) and produces the same capture envelope the
extension does. With a paired plugin, `curl` the relay:

```
curl -X POST http://localhost:8088/v1/renders \
  -H "authorization: Bearer <key>" -H "content-type: application/json" \
  -d '{"channel":"default","name":"Pricing","payload":{"kind":"html","html":"<!doctype html><h1>Hi</h1>"}}'
# → { "renderId": "...", "status": "translating" }  then poll GET /v1/renders/<id>
```

Worker hardening for `url` kind: https-only + SSRF egress block (private/loopback/link-local/metadata
ranges) before navigation. Standalone worker needs pg-boss + Supabase Storage (pending); for local
dev it runs in-process with the relay.

## Automated proxies for the journeys

- **J1** (extension → relay → plugin): `apps/relay/test/e2e.test.ts`
- **J3** (HTML → worker → plugin): `apps/relay/test/worker-e2e.test.ts` (real Chromium)

Both drive a real server + WS client + payload/asset fetch with the same adapters the apps use, and
assert the render reaches `done`. Run: `npx --yes pnpm@9.15.4 --filter @designbridge/app-relay test`.
