import type { Storage } from "./storage/types.js";
import type { Store } from "./store/types.js";

/**
 * Delete unreferenced assets whose last use is older than the cutoff, from both the metadata store
 * and the blob storage (NFR-5: assets GC after 7 days of non-use). Returns the deleted hashes.
 * Wire to a daily cron in production (TECHNICAL-SPEC §4).
 */
export async function gcAssets(
  store: Store,
  storage: Storage,
  cutoffIso: string,
): Promise<string[]> {
  const deleted = await store.gcUnreferencedAssets(cutoffIso);
  for (const hash of deleted) {
    await storage.delete(hash);
  }
  return deleted;
}

/** Convenience: cutoff = now − ageDays (default 7). */
export function gcCutoffIso(now: number, ageDays = 7): string {
  return new Date(now - ageDays * 24 * 60 * 60 * 1000).toISOString();
}
