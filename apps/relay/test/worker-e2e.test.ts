import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { toBuilderData, type CaptureEnvelope } from "@designbridge/schema";
import { chromium, type Browser } from "playwright";
import { WebSocket } from "ws";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
// worker source imported directly (test-only cross-app wiring; no package coupling)
import { makeTranslateHandler } from "../../worker/src/translate.js";
import { WS_SUBPROTOCOL } from "../src/ws/protocol.js";
import { makeRig, type TestRig } from "./helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const captureBundle = readFileSync(
  resolve(here, "../../../packages/capture-core/dist/content.js"),
  "utf8",
);

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
}, 60_000);
afterAll(async () => {
  await browser?.close();
});

let rig: TestRig | undefined;
let socket: WebSocket | undefined;
afterEach(async () => {
  socket?.close();
  socket = undefined;
  await rig?.app.close();
  rig = undefined;
});

function frameCollector(ws: WebSocket) {
  const received: Record<string, unknown>[] = [];
  const waiters: Array<{ type: string; resolve: (f: Record<string, unknown>) => void }> = [];
  ws.on("message", (data) => {
    const frame = JSON.parse(String(data)) as Record<string, unknown>;
    received.push(frame);
    const idx = waiters.findIndex((w) => w.type === frame.type);
    if (idx >= 0) waiters.splice(idx, 1)[0]!.resolve(frame);
  });
  return {
    next(type: string, timeoutMs = 15_000): Promise<Record<string, unknown>> {
      const existing = received.find((f) => f.type === type);
      if (existing) return Promise.resolve(existing);
      return new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error(`timeout waiting for ${type}`)), timeoutMs);
        waiters.push({ type, resolve: (f) => (clearTimeout(t), res(f)) });
      });
    },
  };
}

describe("J3: raw HTML → translation worker → plugin builds on canvas", () => {
  it("renders HTML headlessly, delivers it, and the render reaches 'done'", async () => {
    rig = await makeRig();
    // wire the worker in-process: it consumes `translate` and (via the relay) enqueues `deliver`
    rig.queue.subscribe(
      "translate",
      makeTranslateHandler({
        browser,
        store: rig.store,
        storage: rig.storage,
        queue: rig.queue,
        captureBundle,
      }),
    );

    await rig.app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = rig.app.server.address() as AddressInfo;

    // plugin connects + pairs
    socket = new WebSocket(`ws://127.0.0.1:${port}/v1/ws`, WS_SUBPROTOCOL);
    const frames = frameCollector(socket);
    await new Promise<void>((res, rej) => {
      socket!.on("open", () => res());
      socket!.on("error", rej);
    });
    socket.send(JSON.stringify({ type: "hello", schemaVersion: "1.0.0" }));
    const code = String((await frames.next("pair.code")).code);
    await rig.app.inject({ method: "POST", url: "/v1/pair", headers: rig.auth, payload: { code } });
    await frames.next("paired");

    // REST user (curl/J3) submits raw HTML
    const html =
      "<!doctype html><html><body style='margin:0'>" +
      "<h1 style='color:#0d99ff'>Pricing</h1><p>Simple, transparent pricing.</p>" +
      "</body></html>";
    const submit = await rig.app.inject({
      method: "POST",
      url: "/v1/renders",
      headers: rig.auth,
      payload: { channel: "default", name: "Pricing", payload: { kind: "html", html } },
    });
    expect(submit.statusCode).toBe(202);
    expect(submit.json().status).toBe("translating");
    const renderId = submit.json().renderId as string;

    // worker renders + delivers → plugin gets render.new
    const renderNew = await frames.next("render.new");
    expect(renderNew.renderId).toBe(renderId);

    // plugin fetches the payload (worker-produced envelope) and hands it to the builder
    const u = new URL(String(renderNew.payloadUrl));
    const payloadRes = await fetch(`http://127.0.0.1:${port}${u.pathname}${u.search}`);
    expect(payloadRes.status).toBe(200);
    const envelope = (await payloadRes.json()) as CaptureEnvelope;
    expect(envelope.source.kind).toBe("server-render");
    const builderData = toBuilderData(envelope);
    expect((builderData.tree as { tag: string }).tag).toBeTruthy();

    socket.send(JSON.stringify({ type: "render.ack", renderId }));
    socket.send(JSON.stringify({ type: "render.done", renderId, summary: { layers: 3 } }));

    let status = "";
    for (let i = 0; i < 40 && status !== "done"; i++) {
      const res = await rig.app.inject({
        method: "GET",
        url: `/v1/renders/${renderId}`,
        headers: rig.auth,
      });
      status = res.json().status;
      if (status === "done" || status === "failed") break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(status).toBe("done");
  }, 40_000);

  it("fails the render (not the worker) on a blocked SSRF url", async () => {
    rig = await makeRig();
    rig.queue.subscribe(
      "translate",
      makeTranslateHandler({
        browser,
        store: rig.store,
        storage: rig.storage,
        queue: rig.queue,
        captureBundle,
      }),
    );
    await pairOnly(rig);

    const submit = await rig.app.inject({
      method: "POST",
      url: "/v1/renders",
      headers: rig.auth,
      payload: {
        channel: "default",
        payload: { kind: "url", url: "https://169.254.169.254/latest" },
      },
    });
    expect(submit.statusCode).toBe(202);
    const renderId = submit.json().renderId as string;

    let status = "";
    let errorCode = "";
    for (let i = 0; i < 40 && status !== "failed"; i++) {
      const res = await rig.app.inject({
        method: "GET",
        url: `/v1/renders/${renderId}`,
        headers: rig.auth,
      });
      status = res.json().status;
      errorCode = res.json().error?.code ?? "";
      if (status === "failed" || status === "done") break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(status).toBe("failed");
    expect(errorCode).toBe("nav_blocked");
  }, 40_000);
});

/** Pair a channel for this key without keeping a socket open (delivery not needed for SSRF test). */
async function pairOnly(r: TestRig): Promise<void> {
  const channel = await r.store.createChannel({ label: null });
  await r.store.linkKeyChannel(r.apiKeyId, channel.id, true);
}
