import { randomUUID } from "node:crypto";
import { DataType, newDb } from "pg-mem";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sha256, uuid } from "../src/lib/ids.js";
import { InMemoryStore } from "../src/store/memory.js";
import { PostgresStore, runMigrations, type Queryable } from "../src/store/postgres.js";
import type { ApiKey, Render, Store } from "../src/store/types.js";

/** Spin up a pg-mem database with the relay schema applied — a real SQL engine, no Docker. */
async function makePgMemStore(): Promise<Store> {
  const db = newDb();
  db.public.registerFunction({
    name: "gen_random_uuid",
    returns: DataType.uuid,
    implementation: () => randomUUID(),
    impure: true,
  });
  const { Pool } = db.adapters.createPg();
  const pool = new Pool();
  await runMigrations(pool as unknown as Queryable);
  return new PostgresStore(pool as unknown as Queryable);
}

const MISSING_ID = "00000000-0000-0000-0000-000000000000"; // valid uuid that never exists

const STORES: Array<[string, () => Promise<Store>]> = [
  ["InMemoryStore", async () => new InMemoryStore()],
  ["PostgresStore (pg-mem)", makePgMemStore],
];

function sampleKey(overrides: Partial<ApiKey> = {}): ApiKey {
  return {
    id: uuid(),
    userId: null,
    keyHash: sha256("raw-" + uuid()),
    keyPrefix: "db_live_aaaa",
    name: "test",
    rateLimitPerMin: 10,
    dailyRenderLimit: 100,
    revokedAt: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function sampleRender(
  apiKeyId: string,
  channelId: string,
  overrides: Partial<Render> = {},
): Render {
  return {
    id: uuid(),
    apiKeyId,
    channelId,
    kind: "capture",
    status: "queued",
    schemaVersion: "1.0.0",
    payloadBytes: 123,
    name: "Pricing",
    warnings: [{ code: "raster-region", nodeId: "n1", detail: "gradient" }],
    error: null,
    timing: {},
    payloadToken: "tok-" + uuid(),
    createdAt: new Date().toISOString(),
    doneAt: null,
    ...overrides,
  };
}

describe.each(STORES)("Store contract: %s", (_name, makeStore) => {
  let store: Store;
  beforeEach(async () => {
    store = await makeStore();
  });
  afterEach(() => {
    // pg-mem pools are in-memory; nothing to close.
  });

  it("looks up api keys by hash and reflects revocation", async () => {
    const key = sampleKey();
    await store.insertApiKey(key);
    const found = await store.getApiKeyByHash(key.keyHash);
    expect(found?.id).toBe(key.id);
    expect(found?.rateLimitPerMin).toBe(10);
    expect(await store.getApiKeyByHash("nope")).toBeNull();

    await store.insertApiKey(
      sampleKey({ keyHash: sha256("revoked"), revokedAt: new Date().toISOString() }),
    );
    const revoked = await store.getApiKeyByHash(sha256("revoked"));
    expect(revoked?.revokedAt).toBeTruthy();
  });

  it("creates channels and finds them by id and token hash", async () => {
    const channel = await store.createChannel({ label: "My File" });
    expect(channel.id).toBeTruthy();
    expect((await store.getChannel(channel.id))?.label).toBe("My File");

    const tokenHash = sha256("channel-token");
    await store.setChannelToken(channel.id, tokenHash);
    expect((await store.getChannelByTokenHash(tokenHash))?.id).toBe(channel.id);

    const at = new Date().toISOString();
    await store.touchChannel(channel.id, at);
    expect((await store.getChannel(channel.id))?.lastConnectedAt).toBe(at);
  });

  it("runs the pairing lifecycle: create, claim, delete-for-channel", async () => {
    const key = sampleKey();
    await store.insertApiKey(key);
    const channel = await store.createChannel({ label: null });
    const expiresAt = new Date(Date.now() + 600000).toISOString();
    await store.createPairing({ code: "K7M3QF", channelId: channel.id, expiresAt });

    const pairing = await store.getPairing("K7M3QF");
    expect(pairing?.channelId).toBe(channel.id);
    expect(pairing?.claimedAt).toBeNull();

    const at = new Date().toISOString();
    await store.claimPairing("K7M3QF", key.id, at);
    expect((await store.getPairing("K7M3QF"))?.claimedAt).toBe(at);

    await store.deletePairingsForChannel(channel.id);
    expect(await store.getPairing("K7M3QF")).toBeNull();
  });

  it("links keys to channels and tracks the default", async () => {
    const key = sampleKey();
    await store.insertApiKey(key);
    const a = await store.createChannel({ label: "A" });
    const b = await store.createChannel({ label: "B" });

    await store.linkKeyChannel(key.id, a.id, true);
    expect(await store.isKeyLinkedToChannel(key.id, a.id)).toBe(true);
    expect(await store.isKeyLinkedToChannel(key.id, b.id)).toBe(false);
    expect((await store.getDefaultChannelForKey(key.id))?.id).toBe(a.id);

    // linking b as the new default demotes a
    await store.linkKeyChannel(key.id, b.id, true);
    expect((await store.getDefaultChannelForKey(key.id))?.id).toBe(b.id);
    const bindings = await store.getChannelsForKey(key.id);
    expect(bindings).toHaveLength(2);
    expect(bindings.filter((x) => x.isDefault)).toHaveLength(1);
  });

  it("creates, reads, and updates renders", async () => {
    const key = sampleKey();
    await store.insertApiKey(key);
    const channel = await store.createChannel({ label: null });
    const render = sampleRender(key.id, channel.id);
    await store.createRender(render);

    const read = await store.getRender(render.id);
    expect(read?.status).toBe("queued");
    expect(read?.warnings[0]?.detail).toBe("gradient");
    expect(read?.payloadToken).toBe(render.payloadToken);

    const doneAt = new Date().toISOString();
    const updated = await store.updateRender(render.id, {
      status: "done",
      error: { code: "x", message: "y" },
      doneAt,
    });
    expect(updated?.status).toBe("done");
    expect(updated?.error?.code).toBe("x");
    expect(updated?.doneAt).toBe(doneAt);
    expect(await store.updateRender(MISSING_ID, { status: "done" })).toBeNull();
  });

  it("returns deliverable renders oldest-first, excluding terminal ones, and counts by key", async () => {
    const key = sampleKey();
    await store.insertApiKey(key);
    const channel = await store.createChannel({ label: null });
    const older = sampleRender(key.id, channel.id, { createdAt: "2026-06-13T10:00:00.000Z" });
    const newer = sampleRender(key.id, channel.id, { createdAt: "2026-06-13T11:00:00.000Z" });
    const done = sampleRender(key.id, channel.id, {
      status: "done",
      createdAt: "2026-06-13T09:00:00.000Z",
    });
    await store.createRender(older);
    await store.createRender(newer);
    await store.createRender(done);

    const deliverable = await store.getDeliverableRenders(channel.id);
    expect(deliverable.map((r) => r.id)).toEqual([older.id, newer.id]);

    expect(await store.countRendersForKeySince(key.id, "2026-06-13T09:30:00.000Z")).toBe(2);
    expect(await store.countRendersForKeySince(key.id, "2026-06-13T00:00:00.000Z")).toBe(3);
  });

  it("creates users, finds them case-insensitively by email, and scopes keys per user", async () => {
    const user = await store.createUser({ email: "Fhg@Figmenta.com" });
    expect(user.id).toBeTruthy();
    expect((await store.getUserByEmail("fhg@figmenta.com"))?.id).toBe(user.id);
    expect(await store.getUserByEmail("nobody@x.com")).toBeNull();

    const other = await store.createUser({ email: "other@x.com" });
    const k1 = sampleKey({ userId: user.id, keyHash: sha256("k1-" + uuid()) });
    const k2 = sampleKey({ userId: user.id, keyHash: sha256("k2-" + uuid()) });
    const k3 = sampleKey({ userId: other.id, keyHash: sha256("k3-" + uuid()) });
    await store.insertApiKey(k1);
    await store.insertApiKey(k2);
    await store.insertApiKey(k3);

    const mine = await store.getApiKeysForUser(user.id);
    expect(mine.map((k) => k.id).sort()).toEqual([k1.id, k2.id].sort());
    expect((await store.getApiKeyById(k1.id))?.id).toBe(k1.id);
    expect(await store.getApiKeyById(MISSING_ID)).toBeNull();
  });

  it("revokes a key by id", async () => {
    const user = await store.createUser({ email: "rev@x.com" });
    const key = sampleKey({ userId: user.id });
    await store.insertApiKey(key);
    const at = new Date().toISOString();
    await store.revokeApiKey(key.id, at);
    expect((await store.getApiKeyById(key.id))?.revokedAt).toBe(at);
  });

  it("buckets render counts by UTC day for a set of keys (usage chart)", async () => {
    const user = await store.createUser({ email: "usage@x.com" });
    const key = sampleKey({ userId: user.id });
    await store.insertApiKey(key);
    const channel = await store.createChannel({ label: null });
    for (const createdAt of [
      "2026-06-14T01:00:00.000Z",
      "2026-06-14T23:00:00.000Z",
      "2026-06-12T10:00:00.000Z",
    ]) {
      await store.createRender(sampleRender(key.id, channel.id, { createdAt }));
    }
    const daily = await store.getDailyRenderCounts([key.id], "2026-06-01T00:00:00.000Z");
    const byDay = Object.fromEntries(daily.map((d) => [d.day, d.count]));
    expect(byDay["2026-06-14"]).toBe(2);
    expect(byDay["2026-06-12"]).toBe(1);
    expect(daily.map((d) => d.day)).toEqual([...daily.map((d) => d.day)].sort());
    expect(await store.getDailyRenderCounts([], "2026-06-01T00:00:00.000Z")).toEqual([]);
  });

  it("round-trips payload bytes", async () => {
    const key = sampleKey();
    await store.insertApiKey(key);
    const channel = await store.createChannel({ label: null });
    const render = sampleRender(key.id, channel.id);
    await store.createRender(render);

    const payload = Buffer.from(JSON.stringify({ schemaVersion: "1.0.0", hello: "world" }), "utf8");
    await store.putPayload(render.id, payload);
    const back = await store.getPayload(render.id);
    expect(back?.toString("utf8")).toBe(payload.toString("utf8"));
    expect(await store.getPayload(MISSING_ID)).toBeNull();
  });
});
