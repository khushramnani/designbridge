import { RelayError } from "./lib/errors.js";
import { sha256 } from "./lib/ids.js";
import type { ApiKey, Store } from "./store/types.js";

/** Resolve and validate a Bearer API key. Throws RelayError on missing/invalid/revoked. */
export async function authenticate(store: Store, authHeader: string | undefined): Promise<ApiKey> {
  const raw = parseBearer(authHeader);
  if (!raw || !raw.startsWith("db_")) {
    throw new RelayError("invalid_api_key", "missing or malformed Authorization bearer token");
  }
  const key = await store.getApiKeyByHash(sha256(raw));
  if (!key) {
    throw new RelayError("invalid_api_key", "API key not recognized");
  }
  if (key.revokedAt) {
    throw new RelayError("revoked_api_key", "API key has been revoked");
  }
  return key;
}

function parseBearer(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1]!.trim() : null;
}

/** Returns the raw bearer token (for keyPrefix display on pairing), or null. */
export function rawBearer(authHeader: string | undefined): string | null {
  return parseBearer(authHeader);
}
