import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { WS_SUBPROTOCOL } from "../src/ws/protocol.js";
import { makeRig, type TestRig } from "./helpers.js";

let rig: TestRig | undefined;
afterEach(async () => {
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
    next(type: string): Promise<Record<string, unknown>> {
      const existing = received.find((f) => f.type === type);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve) => waiters.push({ type, resolve }));
    },
  };
}

describe("WS transport wiring (real @fastify/websocket server)", () => {
  it("accepts a connection and runs the hello → pair.code handshake", async () => {
    rig = await makeRig();
    await rig.app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = rig.app.server.address() as AddressInfo;

    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/ws`, WS_SUBPROTOCOL);
    const frames = frameCollector(ws);
    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", reject);
    });

    ws.send(JSON.stringify({ type: "hello", pluginVersion: "1", schemaVersion: "1.0.0" }));
    const helloOk = await frames.next("hello.ok");
    expect(helloOk.paired).toBe(false);
    expect(typeof helloOk.channelId).toBe("string");

    const pairCode = await frames.next("pair.code");
    expect(String(pairCode.code)).toMatch(/^[A-Z2-9]{6}$/);

    ws.close();
  });
});
