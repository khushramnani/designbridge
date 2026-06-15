import { InMemoryStore, sha256, uuid, type Render, type Store } from "@designbridge/app-relay";
import { beforeEach, describe, expect, it } from "vitest";
import { AccountError, AccountService, MAX_KEYS_PER_USER } from "../src/lib/accounts.js";

const NOW = Date.parse("2026-06-14T12:00:00.000Z"); // "today" (UTC) = 2026-06-14

let store: Store;
let svc: AccountService;
beforeEach(() => {
  store = new InMemoryStore();
  svc = new AccountService(store, () => NOW);
});

function seedRender(apiKeyId: string, createdAt: string): Promise<void> {
  const render: Render = {
    id: uuid(),
    apiKeyId,
    channelId: uuid(),
    kind: "html",
    status: "done",
    schemaVersion: "1.0.0",
    payloadBytes: 0,
    name: null,
    warnings: [],
    error: null,
    summary: null,
    timing: {},
    payloadToken: null,
    createdAt,
    doneAt: createdAt,
  };
  return store.createRender(render);
}

describe("users", () => {
  it("ensureUser creates once and is idempotent by email", async () => {
    const a = await svc.ensureUser("Fhg@Figmenta.com");
    const b = await svc.ensureUser("fhg@figmenta.com"); // case-insensitive
    expect(b.id).toBe(a.id);
    expect(a.email).toBe("Fhg@Figmenta.com");
  });
});

describe("issueKey", () => {
  it("returns a db_live_ secret once and stores only its hash", async () => {
    const user = await svc.ensureUser("a@b.com");
    const issued = await svc.issueKey(user.id, "Laptop");

    expect(issued.rawKey).toMatch(/^db_live_[0-9A-Za-z]{32}$/);
    expect(issued.keyPrefix).toBe(issued.rawKey.slice(0, 12));
    expect(issued.name).toBe("Laptop");
    expect(issued.rateLimitPerMin).toBeGreaterThan(0);

    // the raw key validates against the relay's own lookup path
    const found = await store.getApiKeyByHash(sha256(issued.rawKey));
    expect(found?.id).toBe(issued.id);

    // listed keys never expose the secret or the hash
    const [view] = await svc.listKeys(user.id);
    expect(view).toBeDefined();
    expect(Object.keys(view!)).not.toContain("rawKey");
    expect(JSON.stringify(view)).not.toContain(issued.rawKey);
    expect(JSON.stringify(view)).not.toContain(sha256(issued.rawKey));
  });

  it("enforces the per-user key limit (revoked keys do not count)", async () => {
    const user = await svc.ensureUser("c@d.com");
    const issued = [];
    for (let i = 0; i < MAX_KEYS_PER_USER; i++) issued.push(await svc.issueKey(user.id));
    await expect(svc.issueKey(user.id)).rejects.toBeInstanceOf(AccountError);

    await svc.revokeKey(user.id, issued[0]!.id);
    await expect(svc.issueKey(user.id)).resolves.toBeDefined(); // a slot freed up
  });
});

describe("revokeKey", () => {
  it("revokes an owned key and is idempotent", async () => {
    const user = await svc.ensureUser("e@f.com");
    const key = await svc.issueKey(user.id);
    await svc.revokeKey(user.id, key.id);
    await svc.revokeKey(user.id, key.id); // idempotent, no throw
    const [view] = await svc.listKeys(user.id);
    expect(view!.revoked).toBe(true);
    expect(view!.revokedAt).toBeTruthy();
  });

  it("refuses to revoke another user's key", async () => {
    const owner = await svc.ensureUser("owner@x.com");
    const attacker = await svc.ensureUser("attacker@x.com");
    const key = await svc.issueKey(owner.id);
    await expect(svc.revokeKey(attacker.id, key.id)).rejects.toMatchObject({ code: "forbidden" });
  });

  it("reports a missing key", async () => {
    const user = await svc.ensureUser("g@h.com");
    await expect(svc.revokeKey(user.id, uuid())).rejects.toMatchObject({ code: "key_not_found" });
  });
});

describe("usage", () => {
  it("aggregates renders across keys into a zero-filled daily series", async () => {
    const user = await svc.ensureUser("u@s.com");
    const k1 = await svc.issueKey(user.id);
    const k2 = await svc.issueKey(user.id);

    await seedRender(k1.id, "2026-06-14T01:00:00.000Z"); // today
    await seedRender(k1.id, "2026-06-14T09:00:00.000Z"); // today
    await seedRender(k2.id, "2026-06-11T10:00:00.000Z"); // 3 days ago (in window)
    await seedRender(k2.id, "2026-05-01T10:00:00.000Z"); // 44 days ago (outside 30d window)

    const report = await svc.usage(user.id, 30);
    expect(report.daily).toHaveLength(30);
    expect(report.daily[report.daily.length - 1]!.day).toBe("2026-06-14"); // ends today
    expect(report.today).toBe(2);
    expect(report.total).toBe(3); // 2 today + 1 three-days-ago; the 44-day-old one is excluded
    // series is ascending and contiguous
    expect(report.daily.find((d) => d.day === "2026-06-11")!.count).toBe(1);
    expect(report.daily.find((d) => d.day === "2026-06-13")!.count).toBe(0);
  });

  it("returns an empty zero-filled series for a user with no keys", async () => {
    const user = await svc.ensureUser("empty@s.com");
    const report = await svc.usage(user.id, 7);
    expect(report.daily).toHaveLength(7);
    expect(report.total).toBe(0);
    expect(report.today).toBe(0);
  });
});
