import type { DailyCount } from "@designbridge/app-relay";

// A dependency-free server-rendered bar chart. Heights are relative to the busiest day in the window.
export function UsageChart({ daily }: { daily: DailyCount[] }) {
  const max = Math.max(1, ...daily.map((d) => d.count));
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-end",
        gap: 2,
        height: 80,
        borderBottom: "1px solid var(--border)",
      }}
    >
      {daily.map((d) => (
        <div
          key={d.day}
          title={`${d.day}: ${d.count} render${d.count === 1 ? "" : "s"}`}
          style={{
            flex: 1,
            height: `${Math.round((d.count / max) * 100)}%`,
            minHeight: d.count > 0 ? 3 : 1,
            background: d.count > 0 ? "var(--accent)" : "var(--border)",
            borderRadius: "2px 2px 0 0",
          }}
        />
      ))}
    </div>
  );
}
