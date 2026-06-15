import { revokeKeyResponse, unauthorizedResponse } from "../../../../lib/api.js";
import { getSessionUser } from "../../../../lib/session.js";
import { getAccountService } from "../../../../lib/store.js";

export const dynamic = "force-dynamic";

// DELETE /api/keys/:id — revoke a key the signed-in user owns (idempotent; ownership-checked).
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const session = await getSessionUser();
  if (!session) return unauthorizedResponse();
  const { id } = await params;
  return revokeKeyResponse(await getAccountService(), session.user.id, id);
}
