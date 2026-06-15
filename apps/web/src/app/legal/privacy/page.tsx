export const metadata = { title: "Privacy Policy — DesignBridge" };

export default function PrivacyPage() {
  return (
    <div style={{ maxWidth: 720 }}>
      <h1>Privacy Policy</h1>
      <p className="muted">Beta — last updated 2026-06-15. This will be reviewed before public launch.</p>

      <h2>What we collect</h2>
      <ul className="muted" style={{ lineHeight: 1.8 }}>
        <li>
          <strong>Account email</strong> — used only to authenticate you (magic-link sign-in) and
          contact you about the beta.
        </li>
        <li>
          <strong>API keys</strong> — stored only as a salted hash plus a short prefix. We never
          store the full secret; it is shown to you exactly once.
        </li>
        <li>
          <strong>Render metadata</strong> — per render we log the key, channel, kind, size,
          duration, and status to power usage limits and your dashboard. We do not retain the design
          content beyond what is needed to deliver it.
        </li>
      </ul>

      <h2>Design content</h2>
      <p className="muted">
        Designs you send are processed to translate them into Figma layers and delivered to your
        paired plugin. Assets are content-addressed and may be cached transiently to complete
        delivery. We do not sell or share your design content.
      </p>

      <h2>Sub-processors</h2>
      <p className="muted">
        We use Supabase (auth + database) and our own VPS for the relay and translation worker.
      </p>

      <h2>Your choices</h2>
      <p className="muted">
        Revoke keys any time from the dashboard. To delete your account and data, contact us.
      </p>
    </div>
  );
}
