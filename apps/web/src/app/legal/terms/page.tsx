export const metadata = { title: "Terms of Service — DesignBridge" };

export default function TermsPage() {
  return (
    <div style={{ maxWidth: 720 }}>
      <h1>Terms of Service</h1>
      <p className="muted">Beta — last updated 2026-06-15. This will be reviewed before public launch.</p>

      <h2>The beta</h2>
      <p className="muted">
        DesignBridge is provided free during beta, as-is and without warranty. Features, limits, and
        availability may change, and the service may have downtime.
      </p>

      <h2>Acceptable use</h2>
      <ul className="muted" style={{ lineHeight: 1.8 }}>
        <li>Send only content you have the right to use.</li>
        <li>Don&apos;t attempt to abuse the renderer (e.g. SSRF, resource exhaustion) or bypass rate limits.</li>
        <li>Don&apos;t resell or redistribute the service without permission.</li>
      </ul>

      <h2>Rate limits</h2>
      <p className="muted">
        Beta keys have generous per-minute and daily limits. We may adjust limits or suspend keys
        that threaten service stability.
      </p>

      <h2>Your content</h2>
      <p className="muted">
        You retain all rights to your designs. You grant us the limited right to process and deliver
        them to your paired Figma canvas. See the <a href="/legal/privacy">Privacy Policy</a>.
      </p>

      <h2>Termination</h2>
      <p className="muted">
        You can stop using the service and revoke your keys at any time. We may suspend access for
        violations of these terms.
      </p>
    </div>
  );
}
