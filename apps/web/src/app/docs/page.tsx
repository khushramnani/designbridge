import Link from "next/link";

export const metadata = { title: "Docs — DesignBridge" };

export default function DocsIndex() {
  return (
    <div style={{ maxWidth: 720 }}>
      <h1>Documentation</h1>
      <p className="muted">
        Three ways to get an AI design onto your Figma canvas. Pair the plugin once, then pick a
        sender.
      </p>

      <ol className="muted" style={{ lineHeight: 1.9 }}>
        <li>
          <Link href="/dashboard">Create a free API key</Link> and{" "}
          <Link href="/docs/plugin">pair the Figma plugin</Link>.
        </li>
        <li>Connect a sender (below).</li>
        <li>Generate a design — it appears as editable layers.</li>
      </ol>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          gap: 16,
          marginTop: 24,
        }}
      >
        <Card href="/docs/extension" title="Chrome extension" body="Capture designs directly from claude.ai." />
        <Card href="/docs/mcp" title="MCP server" body="send_to_figma from Claude Code, Cowork, or Codex." />
        <Card href="/docs/plugin" title="Figma plugin" body="Install, pair, and receive renders." />
      </div>
    </div>
  );
}

function Card({ href, title, body }: { href: string; title: string; body: string }) {
  return (
    <Link href={href} className="panel" style={{ color: "var(--text)", display: "block" }}>
      <h3 style={{ margin: "0 0 6px" }}>{title}</h3>
      <p className="muted" style={{ margin: 0, fontSize: 14 }}>
        {body}
      </p>
    </Link>
  );
}
