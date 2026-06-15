#!/usr/bin/env node
// Local all-in-one DesignBridge backend — NO Supabase / VPS required.
//
// Runs, in ONE process against the in-memory store (docs/DECISIONS.md D1/D5):
//   • relay      (REST + WS hub + pairing)            http://localhost:<RELAY_PORT>
//   • worker     (Playwright/Chromium, in-process)    consumes `translate` jobs
//   • MCP server (Streamable HTTP)                     http://localhost:<MCP_PORT>/mcp
//
// It seeds and prints a dev API key. In-memory state is dropped on restart.
//
// Usage:  npx --yes pnpm@9.15.4 -r build   (once)
//         node scripts/dev-stack.mjs       (or: npm run dev)
//
// Env: RELAY_PORT (8088), MCP_PORT (8089), HOST (127.0.0.1), DEV_API_KEY (override seed),
//      NO_WORKER=1 (skip Chromium — capture + get_figma_context still work, html renders won't).

import {
  buildApp,
  generateApiKey,
  Hub,
  InMemoryQueue,
  InMemoryStorage,
  InMemoryStore,
  keyPrefix,
  sha256,
  uuid,
} from "@designbridge/app-relay";
import { createMcpHttpServer } from "@designbridge/app-mcp";

const RELAY_PORT = Number(process.env.RELAY_PORT ?? 8080);
const MCP_PORT = Number(process.env.MCP_PORT ?? 8089);
const HOST = process.env.HOST ?? "127.0.0.1"; // bind address (loopback)
// Figma's plugin sandbox only allows the `localhost` hostname in networkAccess (no IP literals),
// so the relay's PUBLIC url — used for the plugin WS + payload fetches — must use `localhost`.
const RELAY_URL = process.env.RELAY_PUBLIC_URL ?? `http://localhost:${RELAY_PORT}`;
const RELAY_INTERNAL = `http://127.0.0.1:${RELAY_PORT}`; // mcp → relay (explicit IPv4 loopback)
const MCP_URL = `http://127.0.0.1:${MCP_PORT}`;

const store = new InMemoryStore();
const storage = new InMemoryStorage();
const queue = new InMemoryQueue((topic, err) => console.error(`[queue:${topic}]`, err));
const hub = new Hub({ store, publicUrl: RELAY_URL });

let browser;
if (process.env.NO_WORKER === "1") {
  console.log("• worker: DISABLED (NO_WORKER=1) — html/url renders will not translate");
} else {
  // In-process translation worker. Dynamic imports so `NO_WORKER=1` skips loading Playwright.
  const { chromium } = await import("playwright");
  const { makeTranslateHandler, loadCaptureBundle } = await import("@designbridge/app-worker");
  try {
    browser = await chromium.launch();
  } catch (err) {
    console.error(
      "\n✗ Could not launch Chromium for the worker. Install it with:\n" +
        "    npx --yes playwright install chromium\n" +
        "  or run without the worker: NO_WORKER=1 node scripts/dev-stack.mjs\n",
    );
    throw err;
  }
  queue.subscribe(
    "translate",
    makeTranslateHandler({ browser, store, storage, queue, captureBundle: loadCaptureBundle() }),
  );
  console.log("• worker: enabled (in-process Chromium)");
}

// Relay logging on by default for the dev stack so 500s surface their stack trace in this console.
const app = buildApp({
  store,
  storage,
  queue,
  hub,
  publicUrl: RELAY_URL,
  logger: process.env.QUIET !== "1",
});

// Seed a dev API key (printed once; reuse via DEV_API_KEY to keep it stable across restarts).
const rawKey = process.env.DEV_API_KEY ?? generateApiKey();
await store.insertApiKey({
  id: uuid(),
  userId: null,
  keyHash: sha256(rawKey),
  keyPrefix: keyPrefix(rawKey),
  name: "dev-stack",
  rateLimitPerMin: 120,
  dailyRenderLimit: 100000,
  revokedAt: null,
  createdAt: new Date().toISOString(),
});

await app.listen({ port: RELAY_PORT, host: HOST });
const mcp = createMcpHttpServer({ relayUrl: RELAY_INTERNAL });
await new Promise((resolve) => mcp.listen(MCP_PORT, HOST, resolve));

console.log(`
┌─ DesignBridge local stack ─────────────────────────────────────────────
│  relay   ${RELAY_URL}        (health: ${RELAY_URL}/v1/health)
│  mcp     ${MCP_URL}/mcp      (health: ${MCP_URL}/health)
│
│  DEV API KEY (Authorization: Bearer <key>):
│    ${rawKey}
│
│  Next:
│   1. Figma → import apps/figma-plugin/dist/manifest.json, set Relay = ${RELAY_URL}
│      → it shows a 6-char pairing code.
│   2. Pair the key to that code:
│      curl -X POST ${RELAY_URL}/v1/pair \\
│        -H "authorization: Bearer ${rawKey}" -H "content-type: application/json" \\
│        -d '{"code":"<PAIRING_CODE>"}'
│   3a. Capture path: load apps/extension/dist in Chrome, set relay+key, capture on claude.ai.
│   3b. MCP path: point Claude Code at ${MCP_URL}/mcp with that bearer key
│       (see docs/runbooks/mcp-setup.md), then "send_to_figma".
│   3c. Raw HTML path:
│      curl -X POST ${RELAY_URL}/v1/renders \\
│        -H "authorization: Bearer ${rawKey}" -H "content-type: application/json" \\
│        -d '{"channel":"default","name":"Hi","payload":{"kind":"html","html":"<!doctype html><h1 style=color:#0d99ff>Hello Figma</h1>"}}'
│
│  Ctrl+C to stop.
└────────────────────────────────────────────────────────────────────────
`);

async function shutdown() {
  console.log("\nshutting down…");
  try {
    await app.close();
  } catch (err) {
    console.error("relay close failed:", err);
  }
  await new Promise((r) => mcp.close(r));
  if (browser) await browser.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
