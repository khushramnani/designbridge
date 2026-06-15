import Link from "next/link";
import { RELAY_PUBLIC_URL } from "../../../lib/env.js";

export const metadata = { title: "MCP server setup — DesignBridge" };

export default function McpDocs() {
  // The MCP server fronts the relay; in local dev it runs alongside it.
  const mcpUrl = RELAY_PUBLIC_URL.replace("8080", "8787") + "/mcp";
  const config = `{
  "mcpServers": {
    "designbridge": {
      "type": "http",
      "url": "${mcpUrl}",
      "headers": { "Authorization": "Bearer \${DESIGNBRIDGE_API_KEY}" }
    }
  }
}`;

  return (
    <div style={{ maxWidth: 720 }}>
      <p className="muted">
        <Link href="/docs">← Docs</Link>
      </p>
      <h1>MCP server</h1>
      <p className="muted">
        The MCP server lets any MCP-capable AI client (Claude Code, Cowork, Codex) push designs to
        your canvas with <code className="inline">send_to_figma</code>, and read it back with{" "}
        <code className="inline">get_figma_context</code>.
      </p>

      <h2>1. Get a key &amp; pair</h2>
      <p className="muted">
        Create an API key on your <Link href="/dashboard">dashboard</Link> and{" "}
        <Link href="/docs/plugin">pair the Figma plugin</Link>.
      </p>

      <h2>2. Add the server to your client</h2>
      <p className="muted">
        Set <code className="inline">DESIGNBRIDGE_API_KEY</code> in your environment, then add this
        to your MCP config (e.g. <code className="inline">.mcp.json</code>):
      </p>
      <pre>{config}</pre>

      <h2>3. Ask for a design</h2>
      <p className="muted">
        &ldquo;Design a pricing page and send it to my Figma.&rdquo; The AI generates standalone
        HTML, <code className="inline">send_to_figma</code> renders it through the relay, and it lands
        on your paired canvas as editable layers.
      </p>

      <p className="muted" style={{ fontSize: 13 }}>
        One-command install via the Claude Code plugin manifest is available — see the runbook at{" "}
        <code className="inline">docs/runbooks/mcp-setup.md</code>.
      </p>
    </div>
  );
}
