import {
  InMemoryStore,
  PostgresStore,
  runMigrations,
  type Queryable,
  type Store,
} from "@designbridge/app-relay";
import { DATABASE_URL, WEB_STORE } from "./env.js";
import { AccountService } from "./accounts.js";

// Lazily-constructed process singleton. Built on first request (never at module load) so `next
// build` doesn't need DATABASE_URL. In serverless the in-memory fallback is per-instance and
// ephemeral — production must set WEB_STORE=postgres + DATABASE_URL (same DB as the relay) so keys
// minted here are exactly the rows the relay validates (docs/DECISIONS.md D6).
let storePromise: Promise<Store> | null = null;

async function createStore(): Promise<Store> {
  if (WEB_STORE === "postgres") {
    if (!DATABASE_URL) throw new Error("WEB_STORE=postgres requires DATABASE_URL");
    const pg = (await import("pg")).default;
    const pool = new pg.Pool({ connectionString: DATABASE_URL });
    await runMigrations(pool as unknown as Queryable);
    return new PostgresStore(pool as unknown as Queryable);
  }
  return new InMemoryStore();
}

export function getStore(): Promise<Store> {
  if (!storePromise) storePromise = createStore();
  return storePromise;
}

/** The account service over the shared Store — the single entry point for all account operations. */
export async function getAccountService(): Promise<AccountService> {
  return new AccountService(await getStore());
}
