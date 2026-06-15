import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { cookies } from "next/headers";
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from "../env.js";

type CookieToSet = { name: string; value: string; options: CookieOptions };

/**
 * Supabase server client bound to the request's cookies. Used by server components and route
 * handlers to read the authenticated session. Cookie writes are best-effort: when called from a
 * Server Component (which cannot mutate cookies) the set throws and we swallow it — the middleware
 * is responsible for refreshing the session cookie on navigation.
 */
export async function createSupabaseServerClient() {
  const cookieStore = await cookies();
  return createServerClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet: CookieToSet[]) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Set from a Server Component — safe to ignore; middleware handles refresh.
        }
      },
    },
  });
}
