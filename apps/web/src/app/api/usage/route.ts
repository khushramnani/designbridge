import { unauthorizedResponse, usageResponse } from "../../../lib/api.js";
import { getSessionUser } from "../../../lib/session.js";
import { getAccountService } from "../../../lib/store.js";

export const dynamic = "force-dynamic";

// GET /api/usage?days=30 — aggregate render usage across the user's keys for the dashboard chart.
export async function GET(request: Request): Promise<Response> {
  const session = await getSessionUser();
  if (!session) return unauthorizedResponse();
  const days = Number(new URL(request.url).searchParams.get("days") ?? 30);
  return usageResponse(await getAccountService(), session.user.id, days);
}
