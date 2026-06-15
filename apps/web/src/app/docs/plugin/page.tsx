import Link from "next/link";

export const metadata = { title: "Figma plugin setup — DesignBridge" };

export default function PluginDocs() {
  return (
    <div style={{ maxWidth: 720 }}>
      <p className="muted">
        <Link href="/docs">← Docs</Link>
      </p>
      <h1>Figma plugin</h1>
      <p className="muted">
        The plugin is the receiver: it holds the WebSocket connection to the relay and builds the
        editable layers on your canvas.
      </p>

      <h2>Install</h2>
      <ol className="muted" style={{ lineHeight: 1.9 }}>
        <li>Install &ldquo;DesignBridge&rdquo; from the Figma Community (or load the dev build during beta).</li>
        <li>Run the plugin — it connects and shows a 6-character pairing code.</li>
      </ol>

      <h2>Pair</h2>
      <ol className="muted" style={{ lineHeight: 1.9 }}>
        <li>
          Open your <Link href="/dashboard">dashboard</Link> and find the &ldquo;Pair your Figma
          plugin&rdquo; panel.
        </li>
        <li>Enter the code from the plugin plus one of your API keys, then press Pair.</li>
        <li>The plugin flips to &ldquo;connected&rdquo; — designs now arrive automatically.</li>
      </ol>

      <h2>Fallbacks</h2>
      <p className="muted">
        No backend? The plugin keeps a paste-JSON box, and the Chrome extension can copy capture
        JSON to your clipboard. The product degrades to offline mode — never to nothing.
      </p>
    </div>
  );
}
