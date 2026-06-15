import { redirect } from "next/navigation";
import { RELAY_PUBLIC_URL } from "../../lib/env.js";
import { getSessionUser } from "../../lib/session.js";
import { getAccountService } from "../../lib/store.js";
import { KeysPanel } from "./keys-panel.js";
import { PairingHelper } from "./pairing-helper.js";
import { UsageChart } from "./usage-chart.js";

// Always rendered per-request: it reads the authenticated session + live usage.
export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const session = await getSessionUser();
  if (!session) redirect("/signin");

  const svc = await getAccountService();
  const [keys, usage] = await Promise.all([
    svc.listKeys(session.user.id),
    svc.usage(session.user.id, 30),
  ]);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 24 }}>
        <h1 style={{ margin: 0 }}>Dashboard</h1>
        <span className="muted">{session.email}</span>
        <form action="/auth/signout" method="post" style={{ marginLeft: "auto" }}>
          <button className="btn btn-ghost" type="submit">
            Sign out
          </button>
        </form>
      </div>

      <section className="panel" style={{ marginBottom: 24 }}>
        <h2 style={{ marginTop: 0 }}>Usage — last 30 days</h2>
        <div style={{ display: "flex", gap: 24, marginBottom: 16 }}>
          <Stat label="Today" value={usage.today} />
          <Stat label="30-day total" value={usage.total} />
        </div>
        <UsageChart daily={usage.daily} />
      </section>

      <KeysPanel initialKeys={keys} />
      <PairingHelper relayUrl={RELAY_PUBLIC_URL} />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div style={{ fontSize: 28, fontWeight: 700 }}>{value}</div>
      <div className="muted" style={{ fontSize: 13 }}>
        {label}
      </div>
    </div>
  );
}
