import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL, supabaseConfigured } from "./lib/env.js";

type CookieToSet = { name: string; value: string; options: CookieOptions };

/**
 * Refresh the Supabase auth cookie on navigation so server components see a live session. Runs in
 * the Edge runtime — deliberately touches only cookies + env, never the Postgres store. No-ops when
 * Supabase isn't configured (e.g. local dev without env) so the app still renders.
 */
export async function middleware(request: NextRequest): Promise<NextResponse> {
  if (!supabaseConfigured()) return NextResponse.next({ request });

  let response = NextResponse.next({ request });
  const supabase = createServerClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet: CookieToSet[]) {
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  // Touch getUser() to trigger token refresh + cookie rotation.
  await supabase.auth.getUser();
  return response;
}

export const config = {
  // Run on everything except static assets and the favicon.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
