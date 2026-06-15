"use client";

import { useState } from "react";
import { supabaseConfigured } from "../../lib/env.js";
import { createSupabaseBrowserClient } from "../../lib/supabase/client.js";

export default function SignInPage() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [message, setMessage] = useState("");
  const configured = supabaseConfigured();

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setStatus("sending");
    setMessage("");
    try {
      const supabase = createSupabaseBrowserClient();
      const { error } = await supabase.auth.signInWithOtp({
        email: email.trim(),
        options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
      });
      if (error) throw error;
      setStatus("sent");
    } catch (err) {
      setStatus("error");
      setMessage(err instanceof Error ? err.message : "Something went wrong. Try again.");
    }
  }

  return (
    <div style={{ maxWidth: 420, margin: "48px auto" }}>
      <h1>Sign in</h1>
      <p className="muted">
        We&apos;ll email you a magic link — no password. Signing in creates your free beta account
        and lets you mint API keys.
      </p>

      {!configured && (
        <div className="panel" style={{ borderColor: "var(--danger)", marginBottom: 16 }}>
          <strong>Auth isn&apos;t configured on this deployment.</strong>
          <p className="muted" style={{ margin: "8px 0 0", fontSize: 14 }}>
            Set <code className="inline">NEXT_PUBLIC_SUPABASE_URL</code> and{" "}
            <code className="inline">NEXT_PUBLIC_SUPABASE_ANON_KEY</code> to enable sign-in.
          </p>
        </div>
      )}

      {status === "sent" ? (
        <div className="panel">
          <h3 style={{ marginTop: 0 }}>Check your inbox</h3>
          <p className="muted" style={{ marginBottom: 0 }}>
            A sign-in link is on its way to <strong>{email}</strong>. It opens your dashboard.
          </p>
        </div>
      ) : (
        <form onSubmit={onSubmit} className="panel">
          <label htmlFor="email" className="muted" style={{ fontSize: 14 }}>
            Email address
          </label>
          <input
            id="email"
            type="email"
            className="field"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            disabled={!configured || status === "sending"}
            style={{ margin: "8px 0 14px" }}
          />
          <button
            type="submit"
            className="btn"
            disabled={!configured || status === "sending"}
            style={{ width: "100%", justifyContent: "center" }}
          >
            {status === "sending" ? "Sending…" : "Email me a magic link"}
          </button>
          {status === "error" && (
            <p style={{ color: "var(--danger)", fontSize: 14, marginBottom: 0 }}>{message}</p>
          )}
        </form>
      )}
    </div>
  );
}
