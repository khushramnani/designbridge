"use client";

import { useState } from "react";
import type { IssuedKey, KeyView } from "../../lib/accounts.js";

export function KeysPanel({ initialKeys }: { initialKeys: KeyView[] }) {
  const [keys, setKeys] = useState<KeyView[]>(initialKeys);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [justCreated, setJustCreated] = useState<IssuedKey | null>(null);

  async function createKey(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim() || undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message ?? "Could not create key");
      const issued = data as IssuedKey;
      setJustCreated(issued);
      const { rawKey: _rawKey, ...view } = issued; // drop the secret from the list view
      setKeys((prev) => [view, ...prev]);
      setName("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create key");
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    if (!confirm("Revoke this key? Anything using it stops working immediately.")) return;
    setError("");
    try {
      const res = await fetch(`/api/keys/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error((await res.json()).message ?? "Could not revoke key");
      setKeys((prev) =>
        prev.map((k) => (k.id === id ? { ...k, revoked: true, revokedAt: new Date().toISOString() } : k)),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not revoke key");
    }
  }

  const activeCount = keys.filter((k) => !k.revoked).length;

  return (
    <section className="panel" style={{ marginBottom: 24 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
        <h2 style={{ margin: 0 }}>API keys</h2>
        <span className="muted" style={{ fontSize: 13 }}>
          {activeCount} active · max 10
        </span>
      </div>

      {justCreated && (
        <div className="panel" style={{ marginTop: 16, borderColor: "var(--accent-2)" }}>
          <strong>Copy your new key now — it won&apos;t be shown again.</strong>
          <pre style={{ marginBottom: 8 }}>{justCreated.rawKey}</pre>
          <button
            className="btn btn-ghost"
            onClick={() => navigator.clipboard?.writeText(justCreated.rawKey)}
          >
            Copy
          </button>{" "}
          <button className="btn btn-ghost" onClick={() => setJustCreated(null)}>
            Dismiss
          </button>
        </div>
      )}

      <form onSubmit={createKey} style={{ display: "flex", gap: 8, margin: "16px 0" }}>
        <input
          className="field"
          placeholder="Key name (optional, e.g. Laptop)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={busy}
        />
        <button className="btn" type="submit" disabled={busy}>
          {busy ? "Creating…" : "Create key"}
        </button>
      </form>
      {error && <p style={{ color: "var(--danger)", fontSize: 14 }}>{error}</p>}

      {keys.length === 0 ? (
        <p className="muted">No keys yet. Create one to start sending designs to Figma.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Key</th>
              <th>Created</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {keys.map((k) => (
              <tr key={k.id}>
                <td>{k.name ?? <span className="muted">—</span>}</td>
                <td>
                  <code className="inline">{k.keyPrefix}…</code>
                </td>
                <td className="muted">{k.createdAt.slice(0, 10)}</td>
                <td>
                  {k.revoked ? (
                    <span style={{ color: "var(--danger)" }}>revoked</span>
                  ) : (
                    <span style={{ color: "var(--accent-2)" }}>active</span>
                  )}
                </td>
                <td style={{ textAlign: "right" }}>
                  {!k.revoked && (
                    <button className="btn btn-danger" onClick={() => revoke(k.id)}>
                      Revoke
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
