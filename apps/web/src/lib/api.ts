import { AccountError, type AccountService } from "./accounts.js";

/**
 * Framework-free HTTP mappings for the account API. Each function takes the service + the
 * authenticated userId + parsed inputs and returns a web-standard `Response`, so the App Router
 * route handlers are a thin auth shell and all the request/response logic is hermetically testable
 * without a Next runtime.
 */

const ERROR_STATUS: Record<AccountError["code"], number> = {
  key_limit_reached: 409,
  key_not_found: 404,
  forbidden: 403,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** 401 for unauthenticated requests — the route handlers return this when there is no session. */
export function unauthorizedResponse(): Response {
  return json({ error: "unauthorized", message: "sign in required" }, 401);
}

/** Run an account operation, translating AccountError into the right HTTP status + JSON body. */
async function guard<T>(op: () => Promise<T>): Promise<Response> {
  try {
    return json(await op());
  } catch (err) {
    if (err instanceof AccountError) {
      return json({ error: err.code, message: err.message }, ERROR_STATUS[err.code]);
    }
    throw err; // unexpected — let the route handler turn it into a 500
  }
}

export function listKeysResponse(svc: AccountService, userId: string): Promise<Response> {
  return guard(async () => ({ keys: await svc.listKeys(userId) }));
}

export async function issueKeyResponse(
  svc: AccountService,
  userId: string,
  body: unknown,
): Promise<Response> {
  const name = parseName(body);
  try {
    const issued = await svc.issueKey(userId, name);
    // 201 + the raw secret, returned exactly once.
    return new Response(JSON.stringify(issued), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  } catch (err) {
    if (err instanceof AccountError) {
      return json({ error: err.code, message: err.message }, ERROR_STATUS[err.code]);
    }
    throw err;
  }
}

export function revokeKeyResponse(
  svc: AccountService,
  userId: string,
  keyId: string,
): Promise<Response> {
  return guard(async () => {
    await svc.revokeKey(userId, keyId);
    return { ok: true };
  });
}

export function usageResponse(
  svc: AccountService,
  userId: string,
  windowDays: number,
): Promise<Response> {
  const days = Number.isFinite(windowDays) ? Math.min(Math.max(Math.trunc(windowDays), 1), 90) : 30;
  return guard(() => svc.usage(userId, days));
}

/** Accept `{ name?: string }`; ignore anything else. Names are trimmed/nulled inside the service. */
function parseName(body: unknown): string | undefined {
  if (body && typeof body === "object" && "name" in body) {
    const n = (body as { name?: unknown }).name;
    if (typeof n === "string") return n;
  }
  return undefined;
}
