import { createHash, randomBytes, randomUUID } from "node:crypto";

/** Pairing-code alphabet: A-Z and 2-9 with ambiguous chars (0/O/1/I) removed (TECHNICAL-SPEC §4). */
const PAIRING_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const BASE62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

export function uuid(): string {
  return randomUUID();
}

/** sha256 hex digest — used for API keys, channel tokens, asset hashes. */
export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** sha256 hex digest of raw bytes (content-addressed assets). */
export function sha256Bytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** 6-char pairing code from the unambiguous alphabet. */
export function generatePairingCode(): string {
  const bytes = randomBytes(6);
  let out = "";
  for (let i = 0; i < 6; i++) {
    out += PAIRING_ALPHABET[bytes[i]! % PAIRING_ALPHABET.length];
  }
  return out;
}

/** 256-bit channel token (hex), shown once to the plugin, stored hashed. */
export function generateChannelToken(): string {
  return randomBytes(32).toString("hex");
}

/** API key: `db_live_` + 32 base62 chars (~190 bits). Returned once; stored as sha256. */
export function generateApiKey(): string {
  const bytes = randomBytes(32);
  let body = "";
  for (let i = 0; i < 32; i++) {
    body += BASE62[bytes[i]! % BASE62.length];
  }
  return `db_live_${body}`;
}

/** Display prefix for a raw key, e.g. `db_live_a1b2`. */
export function keyPrefix(rawKey: string): string {
  return rawKey.slice(0, 12);
}

/** Short opaque token used to authorize a one-shot payload fetch (dev Storage stand-in). */
export function shortToken(): string {
  return randomBytes(16).toString("hex");
}
