import Link from "next/link";

export default function LandingPage() {
  return (
    <div>
      <section style={{ padding: "48px 0 32px" }}>
        <p style={{ color: "var(--accent-2)", fontWeight: 600, letterSpacing: 0.4 }}>
          Free beta
        </p>
        <h1 style={{ fontSize: 44, lineHeight: 1.1, margin: "8px 0 16px", maxWidth: 720 }}>
          Talk to any AI. Watch the design appear in Figma — as editable layers.
        </h1>
        <p className="muted" style={{ fontSize: 18, maxWidth: 640 }}>
          DesignBridge turns AI-generated UIs into faithful, editable Figma frames. Deterministic
          translation, no LLM in the hot path, near-pixel-exact fidelity.
        </p>
        <div style={{ display: "flex", gap: 12, marginTop: 28 }}>
          <Link href="/signin" className="btn">
            Get a free API key
          </Link>
          <Link href="/docs" className="btn btn-ghost">
            Read the docs
          </Link>
        </div>
      </section>

      <section
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
          gap: 16,
          marginTop: 24,
        }}
      >
        {FEATURES.map((f) => (
          <div className="panel" key={f.title}>
            <h3 style={{ margin: "0 0 8px" }}>{f.title}</h3>
            <p className="muted" style={{ margin: 0, fontSize: 14 }}>
              {f.body}
            </p>
          </div>
        ))}
      </section>

      <section className="panel" style={{ marginTop: 32 }}>
        <h2 style={{ marginTop: 0 }}>How it works</h2>
        <ol className="muted" style={{ fontSize: 15, lineHeight: 1.9, marginBottom: 0 }}>
          <li>Install the Figma plugin and pair it with a 6-digit code.</li>
          <li>
            Connect a sender: the Chrome extension on claude.ai, or the MCP server in Claude
            Code / Cowork.
          </li>
          <li>Generate a design — it lands on your canvas as editable layers in seconds.</li>
        </ol>
      </section>
    </div>
  );
}

const FEATURES = [
  {
    title: "Editable, not flattened",
    body: "Real Figma frames, text, and auto-layout — not a screenshot. Keep designing where the AI left off.",
  },
  {
    title: "Deterministic fidelity",
    body: "A headless render + capture engine, not an LLM guess. Every compromise is surfaced as a warning, never silent.",
  },
  {
    title: "Works with your stack",
    body: "Chrome extension, MCP server (Claude Code / Cowork / Codex), or a plain REST call.",
  },
];
