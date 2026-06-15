import type { AddressInfo } from "node:net";
import { toBuilderData, wrapCapture, type NativeCapture } from "@designbridge/schema";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { WS_SUBPROTOCOL } from "../src/ws/protocol.js";
import { makeRig, type TestRig } from "./helpers.js";

let rig: TestRig | undefined;
let socket: WebSocket | undefined;
afterEach(async () => {
  socket?.close();
  socket = undefined;
  await rig?.app.close();
  rig = undefined;
});

/** Collects parsed frames and lets a test await the next one of a given type. */
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
    next(type: string, timeoutMs = 2000): Promise<Record<string, unknown>> {
      const existing = received.find((f) => f.type === type);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeoutMs);
        waiters.push({
          type,
          resolve: (f) => {
            clearTimeout(timer);
            resolve(f);
          },
        });
      });
    },
  };
}

const nativeCapture: NativeCapture = {
  _designbridge: true,
  version: "0.6.0",
  capturedAt: "2026-06-13T12:00:00.000Z",
  sourceUrl: "https://abc.claudeusercontent.com/artifact",
  viewport: { w: 1280, h: 720 },
  warnings: ["Rasterized one gradient"],
  tree: {
    tag: "div",
    x: 0,
    y: 0,
    w: 1280,
    h: 720,
    style: {},
    children: [
      { tag: "h1", x: 24, y: 24, w: 400, h: 48, style: {}, text: "Pricing", children: [] },
    ],
  },
};

describe("end-to-end: extension → relay → plugin (J1 happy path)", () => {
  it("submits a wrapped capture and the plugin builds it, reaching status 'done'", async () => {
    rig = await makeRig();
    await rig.app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = rig.app.server.address() as AddressInfo;

    // --- plugin side: connect + pair (mirrors ui.ts) ---
    socket = new WebSocket(`ws://127.0.0.1:${port}/v1/ws`, WS_SUBPROTOCOL);
    const frames = frameCollector(socket);
    await new Promise<void>((resolve, reject) => {
      socket!.on("open", () => resolve());
      socket!.on("error", reject);
    });
    socket.send(JSON.stringify({ type: "hello", pluginVersion: "0.1.0", schemaVersion: "1.0.0" }));
    await frames.next("hello.ok");
    const code = String((await frames.next("pair.code")).code);

    // --- user side: claim the code with the API key (POST /v1/pair) ---
    const pairRes = await rig.app.inject({
      method: "POST",
      url: "/v1/pair",
      headers: rig.auth,
      payload: { code },
    });
    expect(pairRes.statusCode).toBe(200);
    await frames.next("paired");

    // --- extension/background side: wrap native capture and submit (mirrors background.ts) ---
    const envelope = wrapCapture(nativeCapture, { sourceKind: "extension", dpr: 2 });
    const submit = await rig.app.inject({
      method: "POST",
      url: "/v1/renders",
      headers: rig.auth,
      payload: {
        channel: "default",
        name: "Pricing",
        payload: { kind: "capture", capture: envelope },
      },
    });
    expect(submit.statusCode).toBe(202);
    const renderId = submit.json().renderId as string;

    // --- plugin receives render.new, fetches the payload, hands it to the builder (ui.ts) ---
    const renderNew = await frames.next("render.new");
    expect(renderNew.renderId).toBe(renderId);

    // payloadUrl points at the relay's configured public URL; in-test we hit the real listen port.
    const path =
      new URL(String(renderNew.payloadUrl)).pathname + new URL(String(renderNew.payloadUrl)).search;
    const payloadRes = await fetch(`http://127.0.0.1:${port}${path}`);
    expect(payloadRes.status).toBe(200);
    const fetched = await payloadRes.json();

    // the receiver lowers the envelope back to builder data — the tree must survive intact
    const builderData = toBuilderData(fetched);
    expect(builderData._designbridge).toBe(true);
    expect((builderData.tree as { tag: string }).tag).toBe("div");
    expect(builderData.warnings).toEqual(["Rasterized one gradient"]);

    // plugin acks, builds, and reports done
    socket.send(JSON.stringify({ type: "render.ack", renderId }));
    socket.send(JSON.stringify({ type: "render.done", renderId, summary: { layers: 2 } }));

    // --- poll status until terminal (mirrors GET /v1/renders/:id) ---
    let status = "";
    for (let i = 0; i < 20 && status !== "done"; i++) {
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
  });
});
