import type { User } from "@designbridge/app-relay";
import { supabaseConfigured } from "./env.js";
import { getAccountService } from "./store.js";
import { createSupabaseServerClient } from "./supabase/server.js";

export interface SessionUser {
  /** Our application user row (shared with the relay), keyed to the Supabase identity by email. */
  user: User;
  /** The verified email from Supabase Auth. */
  email: string;
}

/**
 * Resolve the current request's authenticated user, or null if signed out / auth not configured.
 * Uses `getUser()` (which re-validates the token with Supabase) rather than trusting the cookie,
 * then maps the verified email onto our own `User` row via `ensureUser` (idempotent).
 */
export async function getSessionUser(): Promise<SessionUser | null> {
  if (!supabaseConfigured()) return null;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user: authUser },
  } = await supabase.auth.getUser();
  if (!authUser?.email) return null;

  const svc = await getAccountService();
  const user = await svc.ensureUser(authUser.email, authUser.id);
  return { user, email: authUser.email };
}
