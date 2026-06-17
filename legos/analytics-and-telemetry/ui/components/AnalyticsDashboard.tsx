"use client";
import React, { useEffect, useState } from "react";

/** AnalyticsDashboard — metrics widget (slot: analytics_dashboard). */
interface AnalyticsDashboardProps { apiBase?: string; }
interface Count { name: string; day: string; count: number; }

export function AnalyticsDashboard({ apiBase = "" }: AnalyticsDashboardProps) {
  const [counts, setCounts] = useState<Count[]>([]);
  useEffect(() => {
    let active = true;
    (async () => {
      const res = await fetch(`${apiBase}/api/analytics/counts?days=7`);
      if (active && res.ok) { const d = await res.json(); setCounts(d.counts ?? []); }
    })();
    return () => { active = false; };
  }, [apiBase]);

  const byName: Record<string, number> = {};
  for (const c of counts) byName[c.name] = (byName[c.name] ?? 0) + Number(c.count);

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", maxWidth: 480 }}>
      <h3 style={{ margin: "0 0 8px" }}>Last 7 days</h3>
      <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {Object.entries(byName).map(([name, total]) => (
          <li key={name} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid #f1f1f1" }}>
            <span>{name}</span><strong>{total}</strong>
          </li>
        ))}
        {Object.keys(byName).length === 0 && <li style={{ opacity: 0.6 }}>No events yet.</li>}
      </ul>
    </div>
  );
}
