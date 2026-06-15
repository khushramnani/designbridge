"use client";

import { useState } from "react";

export function PairingHelper({ relayUrl }: { relayUrl: string }) {
  const [code, setCode] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [status, setStatus] = useState<"idle" | "pairing" | "ok" | "error">("idle");
  const [message, setMessage] = useState("");

  const curl = `curl -X POST ${relayUrl}/v1/pair \\
  -H "Authorization: Bearer ${apiKey || "db_live_…"}" \\
  -H "Content-Type: application/json" \\
  -d '{"code":"${code || "ABC123"}"}'`;

  async function pair(e: React.FormEvent) {
    e.preventDefault();
    setStatus("pairing");
    setMessage("");
    try {
      const res = await fetch(`${relayUrl}/v1/pair`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey.trim()}` },
        body: JSON.stringify({ code: code.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message ?? data.error ?? `Pairing failed (${res.status})`);
      setStatus("ok");
      setMessage(`Paired with channel ${data.label ?? data.channelId ?? ""}.`);
    } catch (err) {
      // A browser CORS rejection lands here too — the curl fallback below always works.
      setStatus("error");
      setMessage(
        err instanceof Error ? err.message : "Pairing failed. Use the curl command below instead.",
      );
    }
  }

  return (
    <section className="panel" style={{ marginBottom: 24 }}>
      <h2 style={{ marginTop: 0 }}>Pair your Figma plugin</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        Open the DesignBridge plugin in Figma — it shows a 6-character code. Enter it here with one
        of your API keys to bind the plugin to your account.
      </p>
      <form onSubmit={pair} style={{ display: "grid", gap: 10, maxWidth: 520 }}>
        <input
          className="field"
          placeholder="Pairing code (from the Figma plugin)"
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          maxLength={12}
        />
        <input
          className="field"
          placeholder="Your API key (db_live_…)"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
        />
        <button className="btn" type="submit" disabled={status === "pairing" || !code || !apiKey}>
          {status === "pairing" ? "Pairing…" : "Pair"}
        </button>
      </form>
      {status === "ok" && (
        <p style={{ color: "var(--accent-2)", fontSize: 14 }}>{message}</p>
      )}
      {status === "error" && <p style={{ color: "var(--danger)", fontSize: 14 }}>{message}</p>}

      <details style={{ marginTop: 12 }}>
        <summary className="muted" style={{ cursor: "pointer", fontSize: 14 }}>
          Or pair from a terminal
        </summary>
        <pre style={{ marginBottom: 0 }}>{curl}</pre>
      </details>
    </section>
  );
}
