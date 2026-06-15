import { afterEach, describe, expect, it } from "vitest";
import { RelayError } from "../src/lib/errors.js";
import { InMemoryStore } from "../src/store/memory.js";
import { Hub, type HubSocket } from "../src/ws/hub.js";
import type { OutboundFrame } from "../src/ws/protocol.js";
import { makeRig, sampleCapture, type TestRig } from "./helpers.js";

class FakeSocket implements HubSocket {
  readonly sent: OutboundFrame[] = [];
  readyState = 1;
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(): void {
    this.readyState = 3;
  }
  frames<T extends OutboundFrame["type"]>(type: T): Extract<OutboundFrame, { type: T }>[] {
    return this.sent.filter((f) => f.type === type) as Extract<OutboundFrame, { type: T }>[];
  }
}

let rig: TestRig | undefined;
afterEach(async () => {
  await rig?.app.close();
  rig = undefined;
});

async function connectAndPair(rig: TestRig) {
  const sock = new FakeSocket();
  const handler = rig.hub.handleConnection(sock);
  await handler.onMessage(JSON.stringify({ type: "hello", schemaVersion: "1.0.0" }));
  const channelId = sock.frames("hello.ok")[0]!.channelId;
  await rig.store.linkKeyChannel(rig.apiKeyId, channelId, true);
  return { sock, handler, channelId };
}

async function postRender(rig: TestRig) {
  const res = await rig.app.inject({
    method: "POST",
    url: "/v1/renders",
    headers: rig.auth,
    payload: {
      channel: "default",
      name: "X",
      payload: { kind: "capture", capture: sampleCapture() },
    },
  });
  return res.json().renderId as string;
}

describe("WS render delivery", () => {
  it("delivers render.new to an online plugin and advances status on ack/done", async () => {
    rig = await makeRig();
    const { sock, handler } = await connectAndPair(rig);

    const renderId = await postRender(rig);
    const news = sock.frames("render.new");
    expect(news).toHaveLength(1);
    expect(news[0]!.renderId).toBe(renderId);
    expect(news[0]!.payloadUrl).toContain(renderId);
    expect((await rig.store.getRender(renderId))!.status).toBe("delivering");

    await handler.onMessage(JSON.stringify({ type: "render.ack", renderId }));
    expect((await rig.store.getRender(renderId))!.status).toBe("delivered");

    await handler.onMessage(
      JSON.stringify({ type: "render.done", renderId, summary: { layers: 12 } }),
    );
    const done = (await rig.store.getRender(renderId))!;
    expect(done.status).toBe("done");
    expect(done.doneAt).toBeTruthy();
  });

  it("surfaces build progress on GET render and clears it on done", async () => {
    rig = await makeRig();
    const { handler } = await connectAndPair(rig);
    const renderId = await postRender(rig);
    await handler.onMessage(JSON.stringify({ type: "render.ack", renderId }));

    await handler.onMessage(
      JSON.stringify({
        type: "render.progress",
        renderId,
        count: 40,
        total: 150,
        stage: "building",
      }),
    );
    const mid = await rig.app.inject({
      method: "GET",
      url: `/v1/renders/${renderId}`,
      headers: rig.auth,
    });
    expect(mid.json().progress).toMatchObject({ count: 40, total: 150, stage: "building" });

    await handler.onMessage(JSON.stringify({ type: "render.done", renderId }));
    const after = await rig.app.inject({
      method: "GET",
      url: `/v1/renders/${renderId}`,
      headers: rig.auth,
    });
    expect(after.json().progress).toBeNull(); // cleared on terminal
  });

  it("queues renders while offline and flushes exactly once on reconnect", async () => {
    rig = await makeRig();
    // pair first so the key has a channel, then disconnect
    const { sock, handler, channelId } = await connectAndPair(rig);
    handler.onClose();
    sock.readyState = 3;
    expect(rig.hub.isOnline(channelId)).toBe(false);

    const renderId = await postRender(rig);
    expect((await rig.store.getRender(renderId))!.status).toBe("queued");

    // reconnect a fresh socket bound to the same channel via its token
    const token = (await import("../src/lib/ids.js")).generateChannelToken();
    await rig.store.setChannelToken(channelId, (await import("../src/lib/ids.js")).sha256(token));
    const sock2 = new FakeSocket();
    const handler2 = rig.hub.handleConnection(sock2);
    await handler2.onMessage(JSON.stringify({ type: "hello", token }));

    const news = sock2.frames("render.new");
    expect(news).toHaveLength(1);
    expect(news[0]!.renderId).toBe(renderId);
  });

  it("marks a render failed when the plugin reports render.failed", async () => {
    rig = await makeRig();
    const { sock, handler } = await connectAndPair(rig);
    const renderId = await postRender(rig);
    expect(sock.frames("render.new")).toHaveLength(1);
    await handler.onMessage(
      JSON.stringify({
        type: "render.failed",
        renderId,
        error: { code: "build_error", message: "boom" },
      }),
    );
    const r = (await rig.store.getRender(renderId))!;
    expect(r.status).toBe("failed");
    expect(r.error!.code).toBe("build_error");
  });

  it("ignores malformed frames without crashing", async () => {
    rig = await makeRig();
    const sock = new FakeSocket();
    const handler = rig.hub.handleConnection(sock);
    await handler.onMessage("not json");
    expect(sock.frames("error")[0]!.code).toBe("bad_frame");
  });
});

describe("WS context round-trip", () => {
  it("resolves with the plugin's context.response", async () => {
    const store = new InMemoryStore();
    const hub = new Hub({ store, publicUrl: "http://localhost:8080" });
    const sock = new FakeSocket();
    const handler = hub.handleConnection(sock);
    await handler.onMessage(JSON.stringify({ type: "hello", schemaVersion: "1.0.0" }));
    const channelId = sock.frames("hello.ok")[0]!.channelId;

    const promise = hub.requestContext(channelId, "selection");
    const req = sock.frames("context.request")[0]!;
    expect(req.scope).toBe("selection");
    await handler.onMessage(
      JSON.stringify({
        type: "context.response",
        requestId: req.requestId,
        context: { nodes: [{ id: "1" }] },
      }),
    );
    await expect(promise).resolves.toEqual({ nodes: [{ id: "1" }] });
  });

  it("rejects with context_timeout when the plugin is silent", async () => {
    const store = new InMemoryStore();
    const hub = new Hub({ store, publicUrl: "http://localhost:8080", contextTimeoutMs: 20 });
    const sock = new FakeSocket();
    const handler = hub.handleConnection(sock);
    await handler.onMessage(JSON.stringify({ type: "hello" }));
    const channelId = sock.frames("hello.ok")[0]!.channelId;
    await expect(hub.requestContext(channelId, "page")).rejects.toMatchObject({
      code: "context_timeout",
    });
  });

  it("throws channel_offline when no plugin is connected", async () => {
    const store = new InMemoryStore();
    const hub = new Hub({ store, publicUrl: "http://localhost:8080" });
    await expect(hub.requestContext("missing", "selection")).rejects.toBeInstanceOf(RelayError);
  });
});

describe("WS redelivery", () => {
  it("re-sends an un-acked render and fails after max attempts", async () => {
    const store = new InMemoryStore();
    // controllable timer: capture the scheduled callback so we can fire it on demand
    let scheduled: (() => void) | null = null;
    const hub = new Hub({
      store,
      publicUrl: "http://localhost:8080",
      redeliveryIntervalMs: 1000,
      maxDeliveryAttempts: 2,
      heartbeatIntervalMs: 1_000_000,
      setTimer: (fn) => {
        scheduled = fn;
        return () => {
          if (scheduled === fn) scheduled = null;
        };
      },
    });
    const sock = new FakeSocket();
    const handler = hub.handleConnection(sock);
    await handler.onMessage(JSON.stringify({ type: "hello" }));
    const channelId = sock.frames("hello.ok")[0]!.channelId;

    const render = {
      id: "r1",
      apiKeyId: "k",
      channelId,
      kind: "capture" as const,
      status: "queued" as const,
      payloadToken: "tok",
      warnings: [],
      timing: {},
      createdAt: new Date().toISOString(),
    };
    const flush = () => new Promise((r) => setTimeout(r, 0));

    await store.createRender(render);
    await hub.deliver(render);
    expect(sock.frames("render.new")).toHaveLength(1);

    // fire redelivery tick #1 → resend
    scheduled?.();
    await flush();
    expect(sock.frames("render.new").length).toBeGreaterThanOrEqual(2);

    // fire tick #2 → exceeds maxDeliveryAttempts → failed
    scheduled?.();
    await flush();
    expect((await store.getRender("r1"))!.status).toBe("failed");
    expect((await store.getRender("r1"))!.error!.code).toBe("delivery_timeout");
  });
});
