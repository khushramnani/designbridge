import { generateApiKey, keyPrefix, sha256, uuid } from "./lib/ids.js";
import { InMemoryStore } from "./store/memory.js";
import { PostgresStore, runMigrations, type Queryable } from "./store/postgres.js";
import type { Store } from "./store/types.js";
import { buildApp } from "./app.js";
import { Hub } from "./ws/hub.js";

export const relayAppName = "designbridge-relay";

// Public surface for in-process consumers: the MCP server's e2e tests spin up a real relay, and the
// web app (apps/web) shares this persistence layer + key-gen so accounts never drift from the relay.
export { buildApp } from "./app.js";
export { Hub } from "./ws/hub.js";
export { InMemoryStore } from "./store/memory.js";
export { PostgresStore, runMigrations, type Queryable } from "./store/postgres.js";
export { InMemoryStorage, type Storage } from "./storage/types.js";
export { InMemoryQueue, type Queue } from "./queue/types.js";
export { generateApiKey, keyPrefix, sha256, uuid } from "./lib/ids.js";
export type { ApiKey, DailyCount, Render, Store, User } from "./store/types.js";

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 8080);
  const host = process.env.HOST ?? "0.0.0.0";
  const publicUrl = process.env.RELAY_PUBLIC_URL ?? `http://localhost:${port}`;

  // docs/DECISIONS.md D1: in-memory store for dev/CI; Postgres is the production target.
  const store: Store = await createStore();
  const hub = new Hub({ store, publicUrl });
  const app = buildApp({ store, hub, publicUrl, logger: true });

  if (process.env.RELAY_DEV_SEED === "1") {
    await seedDevKey(store);
  }

  await app.listen({ port, host });
  app.log.info(`relay listening on ${publicUrl}`);
}

/** Pick the store from RELAY_STORE (`memory` default, `postgres` for production durability). */
async function createStore(): Promise<Store> {
  if (process.env.RELAY_STORE === "postgres") {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error("RELAY_STORE=postgres requires DATABASE_URL");
    const pg = (await import("pg")).default;
    const pool = new pg.Pool({ connectionString: databaseUrl });
    await runMigrations(pool as unknown as Queryable);
    return new PostgresStore(pool as unknown as Queryable);
  }
  return new InMemoryStore();
}

/** Mint a development API key and print it once so a human can test the pipeline end-to-end. */
async function seedDevKey(store: Store): Promise<void> {
  const raw = generateApiKey();
  await store.insertApiKey({
    id: uuid(),
    userId: null, // anonymous dev key — no user row required
    keyHash: sha256(raw),
    keyPrefix: keyPrefix(raw),
    name: "dev-seed",
    rateLimitPerMin: 60,
    dailyRenderLimit: 1000,
    revokedAt: null,
    createdAt: new Date().toISOString(),
  });
  console.log(`\n  DEV API KEY (use as: Authorization: Bearer <key>):\n  ${raw}\n`);
}

const invokedDirectly = process.argv[1]?.endsWith("index.js");
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
