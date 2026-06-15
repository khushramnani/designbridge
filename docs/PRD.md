# DesignBridge — Product Requirements Document (PRD)

| | |
|---|---|
| **Version** | 1.0 |
| **Date** | 2026-06-12 |
| **Status** | Approved for build |
| **Companion docs** | `docs/TECHNICAL-SPEC.md` (engineering spec), `PRODUCTION-PLAN.md` (strategy), `IMPROVEMENT-PLAN.md` (fidelity roadmap) |

---

## 1. Product overview

**One-liner:** A bridge that connects any AI tool to Figma. The user talks naturally; designs appear on their Figma canvas as editable layers.

**Problem.** AI tools (Claude, Cowork, CLI agents, v0, Lovable, …) generate good UI as HTML/CSS, but designers live in Figma. Today the path from "AI generated it" to "editable Figma layers" is screenshot-and-trace or manual rebuild. Existing HTML→Figma importers produce flattened or broken output.

**Solution.** DesignBridge captures the *rendered* design (real DOM + computed styles, with a confidence model that rasterizes only what can't be rebuilt natively) and reconstructs it in Figma as proper layers — frames, text, fills, borders, effects. Three entry points, one pipeline, one output.

**What makes it defensible:** the deterministic capture engine (`capture-core`). No LLM in the conversion path — output is exact, repeatable, fast (<5s), and free per render.

## 2. Goals / non-goals

**Goals (beta):**

- G1: One-click claude.ai → Figma transfer (extension path), live, no clipboard.
- G2: Any MCP-capable AI ("design X on my figma") → Figma (MCP path).
- G3: Any system (curl/scripts) → Figma via documented REST API.
- G4: ≥99% pixel fidelity on the golden corpus; zero silent degradations.
- G5: Self-serve onboarding: new user → first render in under 10 minutes.

**Non-goals (beta):**

- NG1: No billing/payments (usage tracking only; Stripe post-beta).
- NG2: No LLM translation/normalization anywhere in the pipeline (post-beta opt-in, user-supplied key, if demand appears).
- NG3: No Figma REST API / Figma OAuth (the plugin does all canvas writes).
- NG4: No capture adapters for non-Claude tools (Stitch/v0/Lovable post-beta — they can use the REST/MCP path with their HTML today).
- NG5: No team/multi-seat features.
- NG6: `update_figma_design` (in-place replace) is post-beta (P5).

## 3. Personas

- **P1 — Claude.ai designer.** Uses Claude Design in the browser. Wants the artifact in Figma now. Non-technical. Entry: Chrome extension.
- **P2 — AI-agent power user.** Lives in Cowork / Claude Code / Codex. Wants "make me a dashboard in Figma" to just work. Technical. Entry: MCP.
- **P3 — Developer/automator.** Pipelines, CI, scripts that generate UI. Entry: REST API.

## 4. User journeys (acceptance journeys — each must work end-to-end at beta launch)

### J1 — Extension user (P1)
1. Installs Chrome extension (Web Store) and Figma plugin (Community).
2. Opens plugin in Figma → plugin shows a 6-character pairing code.
3. Gets an API key from designbridge.io (email magic link → instant key); enters key + pairing code in the extension popup. One-time setup.
4. Opens a Claude Design artifact → clicks **"⬡ Send to Figma"**.
5. Within seconds, the design builds on the Figma canvas with live progress; a fidelity report lists layer count, rasterized regions (and why), font substitutions.
6. If the relay is unreachable or unpaired: extension falls back to clipboard JSON + paste-into-plugin (current Phase-1 flow). Never a dead end.

### J2 — MCP user (P2)
1. Adds DesignBridge MCP server to Cowork/Claude Code (config snippet from docs; API key auth).
2. Pairs once (code shown in Figma plugin, entered in a setup prompt or dashboard).
3. Says "design a pricing page on my figma" → AI generates HTML → calls `send_to_figma`.
4. Design appears on canvas; tool returns status + warnings to the AI, which relays them.
5. Says "what's on my canvas?" → AI calls `get_figma_context` → gets a structured summary of selection/page.

### J3 — API user (P3)
1. Gets API key from dashboard. Reads docs page with curl example.
2. `POST /v1/renders` with `kind:"html"` → translation worker renders headlessly → design appears in Figma. Polls `GET /v1/renders/:id` for status.

### J4 — Claude connectors directory user (post-beta, P5)
1. Installs DesignBridge from Claude's integrations page → OAuth consent → done.
2. Works on claude.ai, Cowork, CLI without manual config.

## 5. Functional requirements

Priority: **M** = must (beta blocks launch), **S** = should (beta if time), **L** = later (post-beta).

### FR-1 Chrome extension
- FR-1.1 (M) Capture rendered Claude Design artifact via `capture-core` (existing engine, moved to shared package).
- FR-1.2 (M) Submit capture to relay (`POST /v1/renders`, assets via presigned upload); clipboard fallback preserved.
- FR-1.3 (M) Popup: API key entry, pairing-code entry, connection status, target channel.
- FR-1.4 (M) Capture panel v2: fidelity report (layers, rasterized regions + reason, font substitutions, size warnings) — not raw JSON.
- FR-1.5 (S) Re-show button on iframe re-render (MutationObserver); handle multiple artifacts per page.
- FR-1.6 (M) Chrome Web Store compliant: MV3, no remote code, minimal permissions, privacy policy link.

### FR-2 Figma plugin
- FR-2.1 (M) Persistent WS connection to relay with exponential-backoff reconnect; status UI (disconnected / connected / receiving / building / done).
- FR-2.2 (M) Pairing UI: display code + expiry; show paired key prefix.
- FR-2.3 (M) Receive render → fetch payload + assets → build via `figma-builder` with chunked yields (no UI freeze) → ack/progress/done frames.
- FR-2.4 (M) Import summary with warnings; schema-version mismatch → human-readable "update the plugin" message.
- FR-2.5 (M) Paste-JSON textarea fallback retained.
- FR-2.6 (M) Context responder: serialize current selection/page (names, bounds, fills, text) on `context.request`.
- FR-2.7 (S) "Replace previous import" (tracks `render_id` → node id mapping in `figma.root.setPluginData`).
- FR-2.8 (L) `update_figma_design` in-place replacement.

### FR-3 Relay server
- FR-3.1 (M) REST API per TECHNICAL-SPEC §5 (renders, assets, pairing, health).
- FR-3.2 (M) WS hub per TECHNICAL-SPEC §6 (frames, delivery semantics).
- FR-3.3 (M) Pairing: 6-char codes, 10-min TTL, single-use, rate-limited, brute-force lockout.
- FR-3.4 (M) API-key auth (hashed at rest), per-key rate limits + daily render quota.
- FR-3.5 (M) At-least-once delivery with offline queue (renders persist; pushed on plugin reconnect; idempotent by render id).
- FR-3.6 (M) Usage recording per render (key, channel, kind, bytes, duration, status).
- FR-3.7 (M) Context round-trip (`context.request`/`response`) with 15s timeout.

### FR-4 Translation worker
- FR-4.1 (M) `kind:"html"` (standalone HTML string) and `kind:"url"` (https URL) → sandboxed Chromium render → inject `capture-core` → capture JSON → upload assets → enqueue delivery.
- FR-4.2 (M) Sandbox hardening per TECHNICAL-SPEC §7 (SSRF block, timeouts, resource caps).
- FR-4.3 (M) Standard viewport 1440×900 @ dpr 2; overridable per request.
- FR-4.4 (L) Opt-in LLM normalizer for non-HTML input (user-supplied key). Explicitly out of beta.

### FR-5 MCP server
- FR-5.1 (M) Remote MCP, Streamable HTTP, tools: `send_to_figma`, `get_figma_context` (schemas in TECHNICAL-SPEC §8).
- FR-5.2 (M) API-key auth (header).
- FR-5.3 (S) Claude Code / Cowork plugin manifest for one-command install.
- FR-5.4 (L) OAuth 2.1 (PKCE + DCR) → Claude connectors directory submission.
- FR-5.5 (L) `update_figma_design` tool.

### FR-6 designbridge.io
- FR-6.1 (M) Landing page + docs (extension setup, plugin setup, MCP config, REST curl examples).
- FR-6.2 (M) Supabase Auth (email magic link); instant API key on signup; key management (create/revoke, prefix display).
- FR-6.3 (M) Pairing helper page; usage dashboard (renders over time, quota remaining).
- FR-6.4 (M) Privacy policy + ToS pages (store-review prerequisites).
- FR-6.5 (L) Stripe billing, plans, paywall.

### FR-7 Shared packages
- FR-7.1 (M) `packages/schema`: versioned capture contract, JSON Schema + TS types + validator, used by every app.
- FR-7.2 (M) `packages/capture-core`: existing `content.js` engine as a buildable library (single source of truth for extension + worker).
- FR-7.3 (M) `packages/figma-builder`: existing `code.js` builder as a library (plugin + test harness).
- FR-7.4 (M) `packages/client`: typed relay REST client (extension, MCP, future CLI).

## 6. Non-functional requirements

- **NFR-1 Performance:** p50 submit→canvas < 5s (capture kind); p50 < 10s (html kind incl. headless render). Payload JSON body < 1 MB (assets externalized).
- **NFR-2 Fidelity:** ≥99% pixel match on golden corpus; every compromise surfaced as a warning (zero silent degradations). Pixel-diff score is a release gate.
- **NFR-3 Reliability:** render success rate > 97%; offline plugin → queued, never lost; graceful degradation to clipboard/paste path if backend down.
- **NFR-4 Security:** API keys hashed; pairing codes single-use + TTL; worker treats all input as hostile (SSRF egress block, container isolation, 30s timeout); HTTPS/WSS only; no secrets in client bundles.
- **NFR-5 Privacy:** design content stored only as long as needed for delivery (assets GC after 7 days of non-use); no reading of user data beyond the viewed design; privacy policy published.
- **NFR-6 Scalability:** single VPS (2 vCPU / 8 GB) serves beta; architecture must scale by adding nodes (stateless relay, Postgres-backed queue) without redesign. WS hub target: 5k concurrent connections on beta hardware.
- **NFR-7 Observability:** structured logs (pino), Sentry on all five surfaces, `/v1/health`, uptime monitoring, per-phase render timing recorded.
- **NFR-8 Compatibility:** Chrome ≥ 120 (MV3); Figma desktop app; Node 22 LTS; schema semver-gated across all senders/receivers.

## 7. Success metrics (beta)

| Metric | Target |
|---|---|
| Time-to-first-render (new user) | < 10 min |
| Pipeline p50 (capture → canvas) | < 5 s |
| Render success rate | > 97% |
| Pixel match on golden corpus | ≥ 99% |
| Silent degradations | 0 |
| Weekly active channels (8 weeks post-launch) | 100 |
| Renders/week (8 weeks post-launch) | 1,000 |

## 8. Release criteria (beta launch gate)

1. Journeys J1, J2, J3 pass end-to-end on production infra.
2. All (M) requirements implemented and tested.
3. Golden-corpus pixel-diff ≥ 99%, CI green, no P0/P1 bugs open.
4. Security checklist (TECHNICAL-SPEC §12) signed off.
5. Privacy policy + ToS live; Chrome Web Store and Figma Community submissions filed.
6. Monitoring + alerting live; rollback procedure documented and tested once.

## 9. Risks (product-level)

| Risk | Mitigation |
|---|---|
| Anthropic ToS challenge on extension capture | MCP/REST paths are independent of claude.ai scraping; review ToS pre-launch |
| Store review delays/rejections | Submit early; dev-install docs as bridge; no remote code, minimal permissions |
| Fidelity regressions as pipeline grows | Pixel-diff gate in CI; warnings-first culture |
| Single-VPS outage | Clipboard/paste fallback keeps product usable; status page |
| Low MCP adoption | Extension path is independently valuable; REST path serves automators |
