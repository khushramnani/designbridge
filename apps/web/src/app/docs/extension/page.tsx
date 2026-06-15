import Link from "next/link";

export const metadata = { title: "Chrome extension setup — DesignBridge" };

export default function ExtensionDocs() {
  return (
    <div style={{ maxWidth: 720 }}>
      <p className="muted">
        <Link href="/docs">← Docs</Link>
      </p>
      <h1>Chrome extension</h1>
      <p className="muted">
        The extension captures the design you&apos;re viewing on claude.ai and sends it to your
        paired Figma plugin.
      </p>

      <h2>Install</h2>
      <ol className="muted" style={{ lineHeight: 1.9 }}>
        <li>Install the DesignBridge extension from the Chrome Web Store (or load the dev build during beta).</li>
        <li>Open the popup and paste an API key from your <Link href="/dashboard">dashboard</Link>.</li>
        <li>Set your default channel (usually <code className="inline">default</code>).</li>
      </ol>

      <h2>Use</h2>
      <ol className="muted" style={{ lineHeight: 1.9 }}>
        <li>Open a design on claude.ai.</li>
        <li>Click the DesignBridge button — it captures the rendered DOM and submits it.</li>
        <li>The design appears in Figma within a couple of seconds.</li>
      </ol>

      <p className="muted">
        Offline or not paired? The extension falls back to copying capture JSON to your clipboard,
        which you can paste into the plugin.
      </p>
    </div>
  );
}
