import type { IncomingMessage } from "node:http";

/**
 * Auth strategy boundary (TECHNICAL-SPEC §8). Beta uses a static API-key bearer that the MCP server
 * forwards verbatim to the relay (the relay is the source of truth for key validity). Phase 5 swaps
 * in an OAuth 2.1 + DCR strategy behind this same interface — no tool/transport code changes.
 */
export interface AuthContext {
  /** The relay API key to act as for this request (`db_live_...` or an anonymous beta key). */
  apiKey: string;
}

export interface AuthStrategy {
  /** Resolve the caller's identity from the HTTP request, or null if unauthenticated. */
  authenticate(req: IncomingMessage): Promise<AuthContext | null> | AuthContext | null;
  /** Value for a `WWW-Authenticate` header on 401 (lets clients discover how to authenticate). */
  challenge(): string;
}

const BEARER_RE = /^Bearer\s+(.+)$/i;

export function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers["authorization"];
  if (!header) return null;
  const match = BEARER_RE.exec(Array.isArray(header) ? (header[0] ?? "") : header);
  return match ? match[1]!.trim() : null;
}

/**
 * Beta strategy: accept any non-empty bearer token and forward it to the relay as the API key.
 * The relay rejects invalid/revoked keys (401), so the MCP server doesn't duplicate that check —
 * it only ensures a token is present and well-formed enough to attempt a call.
 */
export class ApiKeyAuth implements AuthStrategy {
  authenticate(req: IncomingMessage): AuthContext | null {
    const token = bearerToken(req);
    if (!token) return null;
    return { apiKey: token };
  }

  challenge(): string {
    return 'Bearer realm="designbridge", error="invalid_token"';
  }
}
