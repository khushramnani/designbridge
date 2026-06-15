import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { gcAssets } from "../src/gc.js";
import { makeRig, pairChannel, type TestRig } from "./helpers.js";

let rig: TestRig | undefined;
afterEach(async () => {
  await rig?.app.close();
  rig = undefined;
});

function hashOf(buf: Buffer): string {
  return `sha256:${createHash("sha256").update(buf).digest("hex")}`;
}

describe("asset upload (presign → PUT → GET)", () => {
  it("presigns unknown assets and reports dedup hits", async () => {
    rig = await makeRig();
    const bytes = Buffer.from("hello-png-bytes");
    const hash = hashOf(bytes);

    const presign = await rig.app.inject({
      method: "POST",
      url: "/v1/assets/presign",
      headers: rig.auth,
      payload: { assets: [{ hash, mime: "image/png", bytes: bytes.byteLength }] },
    });
    expect(presign.statusCode).toBe(200);
    expect(presign.json().uploads[0]).toMatchObject({ hash, exists: false });
    const uploadUrl = presign.json().uploads[0].uploadUrl as string;
    expect(uploadUrl).toContain(hash);

    const put = await rig.app.inject({
      method: "PUT",
      url: new URL(uploadUrl).pathname + new URL(uploadUrl).search,
      headers: { ...rig.auth, "content-type": "application/octet-stream" },
      payload: bytes,
    });
    expect(put.statusCode).toBe(201);

    const get = await rig.app.inject({ method: "GET", url: `/v1/assets/${hash}` });
    expect(get.statusCode).toBe(200);
    expect(get.headers["content-type"]).toContain("image/png");
    expect(Buffer.from(get.rawPayload).equals(bytes)).toBe(true);

    // second presign now reports a dedup hit
    const again = await rig.app.inject({
      method: "POST",
      url: "/v1/assets/presign",
      headers: rig.auth,
      payload: { assets: [{ hash, mime: "image/png", bytes: bytes.byteLength }] },
    });
    expect(again.json().uploads[0]).toMatchObject({ exists: true, uploadUrl: null });
  });

  it("rejects an upload whose bytes do not match the claimed hash", async () => {
    rig = await makeRig();
    const claimed = hashOf(Buffer.from("the-real-bytes"));
    const put = await rig.app.inject({
      method: "PUT",
      url: `/v1/assets/${claimed}?mime=image/png`,
      headers: { ...rig.auth, "content-type": "application/octet-stream" },
      payload: Buffer.from("DIFFERENT bytes"),
    });
    expect(put.statusCode).toBe(422);
    expect(put.json().error.code).toBe("invalid_payload");
  });

  it("404s an unknown asset", async () => {
    rig = await makeRig();
    const res = await rig.app.inject({
      method: "GET",
      url: `/v1/assets/${hashOf(Buffer.from("nope"))}`,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("asset GC", () => {
  it("removes unreferenced, expired assets but keeps referenced ones", async () => {
    rig = await makeRig();
    const channelId = await pairChannel(rig);

    // referenced asset (linked to a render) — must survive
    const keep = Buffer.from("keep-me");
    const keepHash = hashOf(keep);
    await rig.storage.put(keepHash, "image/png", keep);
    await rig.store.upsertAsset({
      hash: keepHash,
      mime: "image/png",
      bytes: keep.byteLength,
      storagePath: keepHash,
    });
    const render = await rig.store.createRender({
      id: "00000000-0000-0000-0000-0000000000aa",
      apiKeyId: rig.apiKeyId,
      channelId,
      kind: "html",
      status: "done",
      warnings: [],
      timing: {},
      createdAt: new Date().toISOString(),
    });
    void render;
    await rig.store.linkRenderAsset("00000000-0000-0000-0000-0000000000aa", keepHash);

    // orphan asset — must be collected
    const orphan = Buffer.from("orphan");
    const orphanHash = hashOf(orphan);
    await rig.storage.put(orphanHash, "image/png", orphan);
    await rig.store.upsertAsset({
      hash: orphanHash,
      mime: "image/png",
      bytes: orphan.byteLength,
      storagePath: orphanHash,
    });

    const deleted = await gcAssets(
      rig.store,
      rig.storage,
      new Date(Date.now() + 60_000).toISOString(),
    );
    expect(deleted).toContain(orphanHash);
    expect(deleted).not.toContain(keepHash);
    expect(await rig.storage.get(orphanHash)).toBeNull();
    expect(await rig.storage.get(keepHash)).not.toBeNull();
  });
});

describe("html render kind enqueues a translate job", () => {
  it("returns 202 translating and publishes a translate job", async () => {
    rig = await makeRig();
    await pairChannel(rig);
    const jobs: unknown[] = [];
    rig.queue.subscribe("translate", async (data) => {
      jobs.push(data);
    });

    const res = await rig.app.inject({
      method: "POST",
      url: "/v1/renders",
      headers: rig.auth,
      payload: {
        channel: "default",
        payload: { kind: "html", html: "<!doctype html><h1>Hi</h1>" },
      },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().status).toBe("translating");

    await rig.queue.drain();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ kind: "html", renderId: res.json().renderId });

    const status = await rig.app.inject({
      method: "GET",
      url: `/v1/renders/${res.json().renderId}`,
      headers: rig.auth,
    });
    expect(status.json().status).toBe("translating");
  });

  it("rejects html over 1 MB with payload_too_large", async () => {
    rig = await makeRig();
    await pairChannel(rig);
    const big = "<!doctype html>" + "x".repeat(1024 * 1024 + 10);
    const res = await rig.app.inject({
      method: "POST",
      url: "/v1/renders",
      headers: rig.auth,
      payload: { channel: "default", payload: { kind: "html", html: big } },
    });
    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBe("payload_too_large");
  });
});
