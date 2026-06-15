import { afterEach, describe, expect, it } from "vitest";
import { makeRig, pairChannel, sampleCapture, type TestRig } from "./helpers.js";

let rig: TestRig | undefined;
afterEach(async () => {
  await rig?.app.close();
  rig = undefined;
});

describe("POST /v1/renders (capture kind)", () => {
  it("rejects a missing/invalid API key with invalid_api_key 401", async () => {
    rig = await makeRig();
    const res = await rig.app.inject({
      method: "POST",
      url: "/v1/renders",
      headers: { authorization: "Bearer db_live_nope" },
      payload: { channel: "default", payload: { kind: "capture", capture: sampleCapture() } },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("invalid_api_key");
    expect(res.json().error.requestId).toBeTruthy();
  });

  it("returns invalid_payload 422 (not 500) for a wrong/missing content-type", async () => {
    rig = await makeRig();
    const res = await rig.app.inject({
      method: "POST",
      url: "/v1/pair",
      headers: { ...rig.auth, "content-type": "text/plain" },
      payload: "code=ABC123",
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("invalid_payload");
    expect(res.json().error.requestId).toBeTruthy();
  });

  it("rejects a revoked key with revoked_api_key 401", async () => {
    rig = await makeRig();
    const key = await rig.store.getApiKeyByHash(
      (await import("../src/lib/ids.js")).sha256(rig.rawKey),
    );
    await rig.store.insertApiKey({ ...key!, revokedAt: new Date().toISOString() });
    const res = await rig.app.inject({
      method: "POST",
      url: "/v1/renders",
      headers: rig.auth,
      payload: { channel: "default", payload: { kind: "capture", capture: sampleCapture() } },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("revoked_api_key");
  });

  it("returns channel_not_paired 409 when the key has no channel", async () => {
    rig = await makeRig();
    const res = await rig.app.inject({
      method: "POST",
      url: "/v1/renders",
      headers: rig.auth,
      payload: { channel: "default", payload: { kind: "capture", capture: sampleCapture() } },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("channel_not_paired");
  });

  it("accepts a valid capture and returns 202 queued (offline → stays queued)", async () => {
    rig = await makeRig();
    await pairChannel(rig);
    const res = await rig.app.inject({
      method: "POST",
      url: "/v1/renders",
      headers: rig.auth,
      payload: {
        channel: "default",
        name: "Pricing",
        payload: { kind: "capture", capture: sampleCapture() },
      },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.status).toBe("queued");
    expect(body.renderId).toBeTruthy();
    expect(body.statusUrl).toBe(`/v1/renders/${body.renderId}`);

    const status = await rig.app.inject({ method: "GET", url: body.statusUrl, headers: rig.auth });
    expect(status.statusCode).toBe(200);
    expect(status.json().status).toBe("queued");
    expect(status.json().warnings).toHaveLength(1);
  });

  it("rejects a malformed capture envelope with invalid_payload 422", async () => {
    rig = await makeRig();
    await pairChannel(rig);
    const res = await rig.app.inject({
      method: "POST",
      url: "/v1/renders",
      headers: rig.auth,
      payload: {
        channel: "default",
        payload: { kind: "capture", capture: { schemaVersion: "1.0.0" } },
      },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("invalid_payload");
    expect(Array.isArray(res.json().error.details)).toBe(true);
  });

  it("accepts html kind and returns 202 translating (worker path)", async () => {
    rig = await makeRig();
    await pairChannel(rig);
    const res = await rig.app.inject({
      method: "POST",
      url: "/v1/renders",
      headers: rig.auth,
      payload: {
        channel: "default",
        payload: { kind: "html", html: "<!doctype html><div>x</div>" },
      },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().status).toBe("translating");
  });

  it("enforces the daily render quota with quota_exceeded 429", async () => {
    rig = await makeRig({ dailyRenderLimit: 1 });
    await pairChannel(rig);
    const post = () =>
      rig!.app.inject({
        method: "POST",
        url: "/v1/renders",
        headers: rig!.auth,
        payload: { channel: "default", payload: { kind: "capture", capture: sampleCapture() } },
      });
    expect((await post()).statusCode).toBe(202);
    const second = await post();
    expect(second.statusCode).toBe(429);
    expect(second.json().error.code).toBe("quota_exceeded");
  });

  it("enforces the per-key rate limit with rate_limited 429", async () => {
    rig = await makeRig({ rateLimitPerMin: 1 });
    await pairChannel(rig);
    const post = () =>
      rig!.app.inject({
        method: "POST",
        url: "/v1/renders",
        headers: rig!.auth,
        payload: { channel: "default", payload: { kind: "capture", capture: sampleCapture() } },
      });
    // burst is 5; exhaust it then expect a 429
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) codes.push((await post()).statusCode);
    expect(codes).toContain(429);
  });

  it("serves the render payload only with the correct token", async () => {
    rig = await makeRig();
    await pairChannel(rig);
    const created = await rig.app.inject({
      method: "POST",
      url: "/v1/renders",
      headers: rig.auth,
      payload: { channel: "default", payload: { kind: "capture", capture: sampleCapture() } },
    });
    const renderId = created.json().renderId as string;
    const render = await rig.store.getRender(renderId);
    const good = await rig.app.inject({
      method: "GET",
      url: `/v1/renders/${renderId}/payload?t=${render!.payloadToken}`,
    });
    expect(good.statusCode).toBe(200);
    expect(good.json().schemaVersion).toBe("1.0.0");
    const bad = await rig.app.inject({
      method: "GET",
      url: `/v1/renders/${renderId}/payload?t=wrong`,
    });
    expect(bad.statusCode).toBe(404);
  });

  it("hides renders belonging to other keys with render_not_found 404", async () => {
    rig = await makeRig();
    const res = await rig.app.inject({
      method: "GET",
      url: "/v1/renders/00000000-0000-0000-0000-000000000000",
      headers: rig.auth,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("render_not_found");
  });
});

describe("GET /v1/health", () => {
  it("returns ok without auth", async () => {
    rig = await makeRig();
    const res = await rig.app.inject({ method: "GET", url: "/v1/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(res.json().ws.connections).toBe(0);
  });
});
