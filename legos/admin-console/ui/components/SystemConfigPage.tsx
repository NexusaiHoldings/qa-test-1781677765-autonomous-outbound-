"use client";
import React, { useEffect, useState } from "react";
import { AdminPageTemplate } from "./AdminPageTemplate";
import { AdminTable, ColumnDef } from "./AdminTable";

interface ConfigEntry { key: string; value: unknown; updated_at: string; }
function tok() { return typeof window !== "undefined" ? (window as any).__ADMIN_TOKEN__ || "" : ""; }
function api(url: string, opts?: RequestInit) { return fetch(url, { ...opts, headers: { "Content-Type": "application/json", "X-Admin-Token": tok(), ...(opts?.headers || {}) } }); }

export function SystemConfigPage() {
  const [entries, setEntries] = useState<ConfigEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [editVal, setEditVal] = useState(""); const [saveErr, setSaveErr] = useState<string | null>(null);

  function load() { setLoading(true); api("/api/admin/config").then(r => r.json()).then(d => { setEntries(d.config || []); setLoading(false); }).catch(e => { setError(String(e)); setLoading(false); }); }
  useEffect(load, []);

  async function save(key: string) {
    let parsed: unknown; try { parsed = JSON.parse(editVal); } catch { setSaveErr("Invalid JSON"); return; }
    const r = await api(`/api/admin/config/${key}`, { method: "PUT", body: JSON.stringify({ value: parsed }) });
    if (!r.ok) { setSaveErr(await r.text()); return; }
    setEditing(null); setSaveErr(null); load();
  }

  const columns: ColumnDef<ConfigEntry>[] = [
    { key: "key", header: "Key", sortable: true },
    {
      key: "value", header: "Value",
      render: (v, row) => editing === row.key ? (
        <div style={{ display: "flex", gap: 6, flexDirection: "column" }}>
          <textarea value={editVal} onChange={e => setEditVal(e.target.value)} rows={2} style={{ width: 280, fontFamily: "monospace", fontSize: 12, padding: 4, border: "1px solid #cbd5e1", borderRadius: 4 }} />
          {saveErr && <span style={{ color: "#ef4444", fontSize: 12 }}>{saveErr}</span>}
          <div style={{ display: "flex", gap: 4 }}>
            <button onClick={() => save(row.key)} style={{ padding: "3px 8px", background: "#22c55e", color: "#fff", border: "none", borderRadius: 3, cursor: "pointer", fontSize: 12 }}>Save</button>
            <button onClick={() => { setEditing(null); setSaveErr(null); }} style={{ padding: "3px 8px", background: "#f1f5f9", border: "1px solid #cbd5e1", borderRadius: 3, cursor: "pointer", fontSize: 12 }}>Cancel</button>
          </div>
        </div>
      ) : (
        <span style={{ cursor: "pointer" }} onClick={() => { setEditing(row.key); setEditVal(v === "<redacted>" ? "" : JSON.stringify(v, null, 2)); setSaveErr(null); }}>
          {v === "<redacted>" ? <em style={{ color: "#94a3b8" }}>{"<redacted>"}</em> : <code style={{ fontSize: 12 }}>{JSON.stringify(v)}</code>}
          {" "}<span style={{ color: "#3b82f6", fontSize: 12 }}>edit</span>
        </span>
      ),
    },
    { key: "updated_at", header: "Updated", sortable: true, render: v => new Date(v).toLocaleString() },
  ];

  return (
    <AdminPageTemplate title="System Config" breadcrumbs={[{ label: "Admin" }, { label: "System Config" }]}>
      <AdminTable columns={columns} rows={entries} loading={loading} error={error} emptyMessage="No config keys found." />
    </AdminPageTemplate>
  );
}
