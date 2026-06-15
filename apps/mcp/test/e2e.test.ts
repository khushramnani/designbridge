import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { WS_SUBPROTOCOL } from "../../relay/src/ws/protocol.js";
import { makeRig, type TestRig } from "../../relay/test/helpers.js";
import { createMcpHttpServer } from "../src/http.js";

/** Collects WS frames so a test can await the next one of a given type. */
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
    next(type: string, timeoutMs = 5000): Promise<Record<string, unknown>> {
      const existing = received.find((f) => f.type === type);
      if (existing) return Promise.resolve(existing);
      return new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error(`timeout waiting for ${type}`)), timeoutMs);
        waiters.push({ type, resolve: (f) => (clearTimeout(t), res(f)) });
      });
    },
  };
}

const firstText = (result: Awaited<ReturnType<Client["callTool"]>>): string => {
  const content = result.content as Array<{ type: string; text?: string }>;
  return content.map((c) => c.text ?? "").join("\n");
};

let rig: TestRig | undefined;
let mcpHttp: Server | undefined;
let socket: WebSocket | undefined;
let mcpClient: Client | undefined;

afterEach(async () => {
  await mcpClient?.close().catch(() => {});
  socket?.close();
  await new Promise<void>((r) => (mcpHttp ? mcpHttp.close(() => r()) : r()));
  await rig?.app.close();
  rig = mcpHttp = socket = mcpClient = undefined;
});

/** Boot relay + MCP HTTP server + a paired, auto-responding scripted plugin; return an MCP client. */
async function bootStack(opts: { apiKey?: string } = {}): Promise<{
  client: Client;
  frames: ReturnType<typeof frameCollector>;
  ws: WebSocket;
}> {
  rig = await makeRig();
  await rig.app.listen({ port: 0, host: "127.0.0.1" });
  const relayPort = (rig.app.server.address() as AddressInfo).port;
  const relayUrl = `http://127.0.0.1:${relayPort}`;

  mcpHttp = createMcpHttpServer({ relayUrl, poll: { pollIntervalMs: 25, timeoutMs: 10_000 } });
  await new Promise<void>((res) => mcpHttp!.listen(0, "127.0.0.1", res));
  const mcpPort = (mcpHttp.address() as AddressInfo).port;

  // scripted plugin: connect, pair to the rig's key, auto-answer context.request
  socket = new WebSocket(`ws://127.0.0.1:${relayPort}/v1/ws`, WS_SUBPROTOCOL);
  const frames = frameCollector(socket);
  await new Promise<void>((res, rej) => {
    socket!.on("open", () => res());
    socket!.on("error", rej);
  });
  socket.on("message", (data) => {
    const frame = JSON.parse(String(data)) as Record<string, unknown>;
    if (frame.type === "context.request") {
      socket!.send(
        JSON.stringify({
          type: "context.response",
          requestId: frame.requestId,
          context: { scope: frame.scope, nodes: [{ id: "1:2", name: "Hero", type: "FRAME" }] },
        }),
      );
    }
  });
  socket.send(JSON.stringify({ type: "hello", schemaVersion: "1.0.0" }));
  const code = String((await frames.next("pair.code")).code);
  await rig.app.inject({ method: "POST", url: "/v1/pair", headers: rig.auth, payload: { code } });
  await frames.next("paired");

  mcpClient = new Client({ name: "test-client", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${mcpPort}/mcp`), {
    requestInit: {
      headers: { authorization: `Bearer ${opts.apiKey ?? rig.rawKey}` },
    },
  });
  await mcpClient.connect(transport);
  return { client: mcpClient, frames, ws: socket };
}

describe("MCP server end-to-end (real relay + Streamable HTTP transport)", () => {
  it("lists the two DesignBridge tools", async () => {
    const { client } = await bootStack();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["get_figma_context", "send_to_figma"]);
  });

  it("get_figma_context round-trips the live canvas through relay → plugin → AI (T3.2)", async () => {
    const { client } = await bootStack();
    const result = await client.callTool({
      name: "get_figma_context",
      arguments: { scope: "selection" },
    });
    expect(result.isError).toBeFalsy();
    const text = firstText(result);
    expect(text).toContain("Figma selection (1 node)");
    expect(text).toContain("Hero");
  });

  it("send_to_figma submits HTML, the render is delivered + built, and warnings surface (T3.1)", async () => {
    const booted = await bootStack();
    const { client, frames } = booted;

    // simulate the translation worker: translate → payload + deliver (no Chromium needed here)
    rig!.queue.subscribe("translate", async (data) => {
      const { renderId } = data as { renderId: string };
      await rig!.store.putPayload(renderId, Buffer.from("{}"));
      await rig!.store.updateRender(renderId, { status: "queued", schemaVersion: "1.0.0" });
      await rig!.queue.publish("deliver", { renderId });
    });
    // plugin acks + completes every render it receives, reporting a build summary
    socket!.on("message", (raw) => {
      const f = JSON.parse(String(raw)) as Record<string, unknown>;
      if (f.type === "render.new") {
        socket!.send(JSON.stringify({ type: "render.ack", renderId: f.renderId }));
        socket!.send(
          JSON.stringify({
            type: "render.done",
            renderId: f.renderId,
            summary: { layers: 7, rasterRegions: 0, fontsSubstituted: 1 },
          }),
        );
      }
    });

    const result = await client.callTool({
      name: "send_to_figma",
      arguments: { html: "<!doctype html><h1>Pricing</h1>", name: "Pricing" },
    });

    await frames.next("render.new").catch(() => {});
    expect(result.isError).toBeFalsy();
    const text = firstText(result);
    expect(text).toContain("Status: done");
    expect(text).toContain("7 layers");
    expect(text).toContain("1 fonts substituted");
  }, 20_000);

  it("rejects calls without a bearer token", async () => {
    rig = await makeRig();
    await rig.app.listen({ port: 0, host: "127.0.0.1" });
    const relayPort = (rig.app.server.address() as AddressInfo).port;
    mcpHttp = createMcpHttpServer({ relayUrl: `http://127.0.0.1:${relayPort}` });
    await new Promise<void>((res) => mcpHttp!.listen(0, "127.0.0.1", res));
    const mcpPort = (mcpHttp.address() as AddressInfo).port;

    const res = await fetch(`http://127.0.0.1:${mcpPort}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Bearer");
  });

  it("health endpoint responds without auth", async () => {
    rig = await makeRig();
    await rig.app.listen({ port: 0, host: "127.0.0.1" });
    const relayPort = (rig.app.server.address() as AddressInfo).port;
    mcpHttp = createMcpHttpServer({ relayUrl: `http://127.0.0.1:${relayPort}` });
    await new Promise<void>((res) => mcpHttp!.listen(0, "127.0.0.1", res));
    const mcpPort = (mcpHttp.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${mcpPort}/health`);
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });
});
