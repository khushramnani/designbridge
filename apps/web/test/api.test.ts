import { InMemoryStore, type Store } from "@designbridge/app-relay";
import { beforeEach, describe, expect, it } from "vitest";
import { AccountService, type IssuedKey, type KeyView, type UsageReport } from "../src/lib/accounts.js";
import {
  issueKeyResponse,
  listKeysResponse,
  revokeKeyResponse,
  unauthorizedResponse,
  usageResponse,
} from "../src/lib/api.js";

const NOW = Date.parse("2026-06-14T12:00:00.000Z");

let store: Store;
let svc: AccountService;
let userId: string;
beforeEach(async () => {
  store = new InMemoryStore();
  svc = new AccountService(store, () => NOW);
  userId = (await svc.ensureUser("u@b.com")).id;
});

async function bodyOf<T>(res: Response): Promise<T> {
  return JSON.parse(await res.text()) as T;
}

type ApiError = { error: string; message: string };

describe("listKeysResponse", () => {
  it("returns 200 with masked keys (no secret/hash)", async () => {
    await svc.issueKey(userId, "Laptop");
    const res = await listKeysResponse(svc, userId);
    expect(res.status).toBe(200);
    const json = await bodyOf<{ keys: KeyView[] }>(res);
    expect(json.keys).toHaveLength(1);
    expect(json.keys[0]!.name).toBe("Laptop");
    // The masked prefix (e.g. "db_live_9fDS") is shown by design; the full secret + hash never are.
    expect(json.keys[0]).not.toHaveProperty("rawKey");
    expect(json.keys[0]).not.toHaveProperty("keyHash");
    expect(json.keys[0]!.keyPrefix).toHaveLength(12);
  });
});

describe("issueKeyResponse", () => {
  it("returns 201 with the raw secret exactly once", async () => {
    const res = await issueKeyResponse(svc, userId, { name: "CI" });
    expect(res.status).toBe(201);
    const json = await bodyOf<IssuedKey>(res);
    expect(json.rawKey).toMatch(/^db_live_[0-9A-Za-z]{32}$/);
    expect(json.name).toBe("CI");
  });

  it("ignores a non-string name", async () => {
    const res = await issueKeyResponse(svc, userId, { name: 123 });
    expect(res.status).toBe(201);
    expect((await bodyOf<IssuedKey>(res)).name).toBeNull();
  });

  it("maps the per-user key limit to 409", async () => {
    for (let i = 0; i < 10; i++) await svc.issueKey(userId);
    const res = await issueKeyResponse(svc, userId, {});
    expect(res.status).toBe(409);
    expect((await bodyOf<ApiError>(res)).error).toBe("key_limit_reached");
  });
});

describe("revokeKeyResponse", () => {
  it("revokes an owned key (200) and is idempotent", async () => {
    const key = await svc.issueKey(userId);
    const res = await revokeKeyResponse(svc, userId, key.id);
    expect(res.status).toBe(200);
    expect((await bodyOf<{ ok: boolean }>(res)).ok).toBe(true);
    expect((await revokeKeyResponse(svc, userId, key.id)).status).toBe(200);
  });

  it("maps a missing key to 404", async () => {
    const res = await revokeKeyResponse(svc, userId, "00000000-0000-0000-0000-000000000000");
    expect(res.status).toBe(404);
    expect((await bodyOf<ApiError>(res)).error).toBe("key_not_found");
  });

  it("maps another user's key to 403", async () => {
    const other = (await svc.ensureUser("other@b.com")).id;
    const key = await svc.issueKey(other);
    const res = await revokeKeyResponse(svc, userId, key.id);
    expect(res.status).toBe(403);
    expect((await bodyOf<ApiError>(res)).error).toBe("forbidden");
  });
});

describe("usageResponse", () => {
  it("returns 200 with a zero-filled series and clamps the window", async () => {
    const res = await usageResponse(svc, userId, 9999); // clamps to 90
    expect(res.status).toBe(200);
    const json = await bodyOf<UsageReport>(res);
    expect(json.windowDays).toBe(90);
    expect(json.daily).toHaveLength(90);
  });

  it("falls back to 30 days on a non-finite window", async () => {
    const json = await bodyOf<UsageReport>(await usageResponse(svc, userId, NaN));
    expect(json.windowDays).toBe(30);
  });
});

describe("unauthorizedResponse", () => {
  it("is a 401 json error", async () => {
    const res = unauthorizedResponse();
    expect(res.status).toBe(401);
    expect((await bodyOf<ApiError>(res)).error).toBe("unauthorized");
  });
});
