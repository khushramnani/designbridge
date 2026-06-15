import { issueKeyResponse, listKeysResponse, unauthorizedResponse } from "../../../lib/api.js";
import { getSessionUser } from "../../../lib/session.js";
import { getAccountService } from "../../../lib/store.js";

export const dynamic = "force-dynamic";

// GET /api/keys — list the signed-in user's keys (masked; never the secret).
export async function GET(): Promise<Response> {
  const session = await getSessionUser();
  if (!session) return unauthorizedResponse();
  return listKeysResponse(await getAccountService(), session.user.id);
}

// POST /api/keys — mint a key. Body: { name?: string }. Returns the raw secret once (201).
export async function POST(request: Request): Promise<Response> {
  const session = await getSessionUser();
  if (!session) return unauthorizedResponse();
  const body = await request.json().catch(() => ({}));
  return issueKeyResponse(await getAccountService(), session.user.id, body);
}
