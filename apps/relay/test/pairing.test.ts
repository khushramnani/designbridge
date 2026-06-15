import { afterEach, describe, expect, it } from "vitest";
import type { HubSocket } from "../src/ws/hub.js";
import type { OutboundFrame } from "../src/ws/protocol.js";
import { makeRig, type TestRig } from "./helpers.js";

let rig: TestRig | undefined;
afterEach(async () => {
  await rig?.app.close();
  rig = undefined;
});

/** In-memory socket double that records outbound frames and feeds inbound ones to the hub. */
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

async function connectPlugin(rig: TestRig, token?: string) {
  const sock = new FakeSocket();
  const handler = rig.hub.handleConnection(sock);
  await handler.onMessage(
    JSON.stringify({ type: "hello", pluginVersion: "1", schemaVersion: "1.0.0", token }),
  );
  return { sock, handler };
}

describe("POST /v1/pair", () => {
  it("completes pairing: plugin gets a paired frame + channel token", async () => {
    rig = await makeRig();
    const { sock } = await connectPlugin(rig);
    const code = sock.frames("pair.code")[0]!.code;

    const res = await rig.app.inject({
      method: "POST",
      url: "/v1/pair",
      headers: rig.auth,
      payload: { code },
    });
    expect(res.statusCode).toBe(200);
    const channelId = sock.frames("hello.ok")[0]!.channelId;
    expect(res.json().channelId).toBe(channelId);

    const paired = sock.frames("paired");
    expect(paired).toHaveLength(1);
    expect(paired[0]!.channelToken).toMatch(/^[a-f0-9]{64}$/);

    // key is now linked → it can list the channel and send renders to it
    const channels = await rig.app.inject({
      method: "GET",
      url: "/v1/channels",
      headers: rig.auth,
    });
    expect(channels.json().channels[0].id).toBe(channelId);
    expect(channels.json().channels[0].online).toBe(true);
  });

  it("accepts the code case-insensitively", async () => {
    rig = await makeRig();
    const { sock } = await connectPlugin(rig);
    const code = sock.frames("pair.code")[0]!.code;
    const res = await rig.app.inject({
      method: "POST",
      url: "/v1/pair",
      headers: rig.auth,
      payload: { code: code.toLowerCase() },
    });
    expect(res.statusCode).toBe(200);
  });

  it("rejects an unknown code with pairing_code_invalid 404", async () => {
    rig = await makeRig();
    const res = await rig.app.inject({
      method: "POST",
      url: "/v1/pair",
      headers: rig.auth,
      payload: { code: "ZZZZZZ" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("pairing_code_invalid");
  });

  it("rejects a claimed code (single-use)", async () => {
    rig = await makeRig();
    const { sock } = await connectPlugin(rig);
    const code = sock.frames("pair.code")[0]!.code;
    await rig.app.inject({ method: "POST", url: "/v1/pair", headers: rig.auth, payload: { code } });
    const again = await rig.app.inject({
      method: "POST",
      url: "/v1/pair",
      headers: rig.auth,
      payload: { code },
    });
    expect(again.statusCode).toBe(404);
  });

  it("reconnect with a valid token authenticates as paired", async () => {
    rig = await makeRig();
    const { sock } = await connectPlugin(rig);
    const code = sock.frames("pair.code")[0]!.code;
    await rig.app.inject({ method: "POST", url: "/v1/pair", headers: rig.auth, payload: { code } });
    const token = sock.frames("paired")[0]!.channelToken;

    const reconnect = await connectPlugin(rig, token);
    const helloOk = reconnect.sock.frames("hello.ok")[0]!;
    expect(helloOk.paired).toBe(true);
    expect(reconnect.sock.frames("pair.code")).toHaveLength(0);
  });
});
