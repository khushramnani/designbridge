import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "DesignBridge — AI designs into editable Figma layers",
  description:
    "Talk to any AI, and the design it builds appears on your Figma canvas as editable layers.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header
          style={{ borderBottom: "1px solid var(--border)", padding: "14px 0", marginBottom: 32 }}
        >
          <div
            className="container"
            style={{ display: "flex", alignItems: "center", gap: 20 }}
          >
            <Link href="/" style={{ fontWeight: 700, color: "var(--text)" }}>
              Design<span style={{ color: "var(--accent)" }}>Bridge</span>
            </Link>
            <nav style={{ display: "flex", gap: 18, marginLeft: "auto", fontSize: 14 }}>
              <Link href="/docs" className="muted">
                Docs
              </Link>
              <Link href="/dashboard" className="muted">
                Dashboard
              </Link>
              <Link href="/signin" className="btn" style={{ padding: "6px 14px" }}>
                Sign in
              </Link>
            </nav>
          </div>
        </header>
        <main className="container">{children}</main>
        <footer
          className="container muted"
          style={{ marginTop: 64, padding: "32px 24px", fontSize: 13 }}
        >
          <div style={{ borderTop: "1px solid var(--border)", paddingTop: 20, display: "flex", gap: 18 }}>
            <span>© DesignBridge</span>
            <Link href="/legal/privacy" className="muted" style={{ marginLeft: "auto" }}>
              Privacy
            </Link>
            <Link href="/legal/terms" className="muted">
              Terms
            </Link>
          </div>
        </footer>
      </body>
    </html>
  );
}
