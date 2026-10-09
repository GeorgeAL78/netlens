import { useEffect, useState } from "react";
import { ago, api, href, useApi } from "../lib.js";
import { AccountSettings, SettingsSection } from "../shared/Setup.jsx";

// Settings as a page (UU-C-087): console, general, login, data & history, ad-block counts.
// The left list jumps to each section.

const SECTIONS = [
  ["console", "UniFi console"],
  ["general", "General"],
  ["login", "Login"],
  ["data", "Data & history"],
  ["adblock", "Ad-block counts"],
];

function Console() {
  const [s, setS] = useState(null);
  const [apiKey, setApiKey] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api("/api/settings").then(setS).catch((e) => setMsg(e.message));
  }, []);
  async function save(test) {
    setBusy(true);
    setMsg("");
    try {
      if (!test) {
        const body = { host: s.host, site: s.site };
        if (apiKey) body.apiKey = apiKey;
        await api("/api/settings", { method: "PUT", body: JSON.stringify(body) });
        setApiKey("");
      }
      const res = await fetch("/api/clients?scope=online");
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`UniFi did not answer: ${j.error || res.statusText}`);
      setMsg(`${test ? "Connected" : "Saved and connected"} — ${j.onlineCount ?? j.clients?.length ?? 0} devices online.`);
    } catch (err) {
      setMsg(err.message);
    } finally {
      setBusy(false);
    }
  }
  if (!s) return <SettingsSection icon="console" title="UniFi console" hint="Loading…" />;
  return (
    <SettingsSection icon="console" title="UniFi console" hint="Where NetLens reads your network from, with a local API key (UniFi Network → Settings → Control Plane → Integrations).">
      <div className="setup-row">
        <label>
          Console address
          <input value={s.host || ""} onChange={(e) => setS({ ...s, host: e.target.value })} placeholder="192.168.1.1" />
        </label>
        <label>
          Site
          <input value={s.site || ""} onChange={(e) => setS({ ...s, site: e.target.value })} placeholder="default" />
        </label>
      </div>
      <label>
        API key
        <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={s.hasApiKey ? "Stored — leave empty to keep" : "Paste your UniFi API key"} autoComplete="off" />
      </label>
      <div className="account-actions">
        <button type="button" className="btn" disabled={busy} onClick={() => save(true)}>Test connection</button>
        <button type="button" className="btn primary" disabled={busy} onClick={() => save(false)}>Save</button>
      </div>
      {msg && <p className="setup-dim">{msg}</p>}
    </SettingsSection>
  );
}

function Data() {
  const { data, reload } = useApi("/api/cache", 30000);
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState("");
  async function run(path, label, confirmText) {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(label);
    setMsg("");
    try {
      await api(path, { method: "POST", body: JSON.stringify({}) });
      setMsg(`${label}: done.`);
      reload();
    } catch (err) {
      setMsg(err.message);
    } finally {
      setBusy("");
    }
  }
  const gaps = data?.gaps?.length || 0;
  return (
    <SettingsSection icon="sliders" title="Updates" hint="NetLens reads UniFi every 5 minutes by itself. These are only for catching up by hand.">
      <div className="kv">
        <div><span>Last update</span><span>{ago(data?.fetchedAt)}</span></div>
        <div><span>Usage detail kept</span><span>{data?.retainDays ?? 30} days</span></div>
        <div><span>Events and samples kept</span><span>90 days</span></div>
        <div><span>Days missing</span><span className={gaps ? "warn" : ""}>{gaps || "none"}</span></div>
      </div>
      <div className="account-actions">
        <button type="button" className="btn" disabled={!!busy} onClick={() => run("/api/cache/delta", "Fetch new data")}>{busy === "Fetch new data" ? "Fetching…" : "Fetch new data now"}</button>
        <button type="button" className="btn" disabled={!!busy || !gaps} onClick={() => run("/api/cache/backfill", "Fetch missing days")}>Fetch missing days{gaps ? ` (${gaps})` : ""}</button>
        <button type="button" className="btn" disabled={!!busy} onClick={() => run("/api/cache/refetch", "Refetch everything", "Re-read the last 8 days from UniFi? This takes a few minutes.")}>Refetch last 8 days</button>
      </div>
      {msg && <p className="setup-dim">{msg}</p>}
    </SettingsSection>
  );
}

function AdBlock() {
  const [s, setS] = useState(null);
  const [port, setPort] = useState("");
  const [msg, setMsg] = useState("");
  const status = useApi("/api/siem", 30000);
  useEffect(() => {
    api("/api/settings").then((x) => {
      setS(x);
      setPort(x.siemPort || "");
    });
  }, []);
  async function save() {
    setMsg("");
    try {
      await api("/api/settings", { method: "PUT", body: JSON.stringify({ siemPort: port }) });
      setMsg(port ? `Listening on ${port}.` : "Listener turned off.");
      status.reload();
    } catch (err) {
      setMsg(err.message);
    }
  }
  const st = status.data;
  return (
    <SettingsSection icon="shield" title="Ad-block counts (optional)" hint="Only for counting ads UniFi's ad blocker stopped — everything else works without this. Point UniFi's CyberSecure → Traffic Logging → SIEM Server at this server and port. Clear the port to turn the listener off.">
      <div className="setup-row">
        <label>
          Listen on port
          <input inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))} placeholder="empty = off" disabled={!s} />
        </label>
        <label>
          Status
          <input readOnly value={st ? (st.error ? `Problem: ${st.error}` : st.listening ? `Listening on ${st.port}${st.lastReceivedAt ? ` · last message ${ago(st.lastReceivedAt)}` : " · nothing received yet"}` : "Not listening") : "…"} />
        </label>
      </div>
      <div className="account-actions">
        <button type="button" className="btn primary" onClick={save} disabled={!s}>Save</button>
      </div>
      {msg && <p className="setup-dim">{msg}</p>}
    </SettingsSection>
  );
}

export default function Settings({ route, version }) {
  const [tz, setTz] = useState(null);
  useEffect(() => {
    if (route.query.s) setTimeout(() => document.getElementById(`s-${route.query.s}`)?.scrollIntoView({ block: "start" }), 300);
  }, [route.query.s]);
  async function saveTz(z) {
    setTz(z);
    await api("/api/settings", { method: "PUT", body: JSON.stringify({ tz: z }) }).catch(() => {});
  }
  const jump = (id) => document.getElementById(`s-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  return (
    <div className="page narrow">
      <div style={{ display: "flex", flexWrap: "wrap", gap: 32, alignItems: "flex-start" }}>
        <nav aria-label="Settings sections" style={{ flex: "1 1 200px", maxWidth: 220, display: "flex", flexDirection: "column", gap: 2, position: "sticky", top: 90 }}>
          <h1 style={{ marginBottom: 14 }}>Settings</h1>
          {SECTIONS.map(([id, label]) => (
            <a key={id} href={href("settings", null, { s: id })} onClick={(e) => { e.preventDefault(); jump(id); }} className="btn" style={{ justifyContent: "flex-start", border: 0, background: "transparent" }}>
              {label}
            </a>
          ))}
          <span className="dim small" style={{ padding: "16px 14px 0" }}>NetLens {version ? (/^\d/.test(version) ? `v${version}` : version) : ""}</span>
        </nav>
        <main className="settings-page" style={{ flex: "999 1 520px", minWidth: 0, display: "flex", flexDirection: "column", gap: 16 }}>
          <div id="s-console"><Console /></div>
          <AccountSettings tz={tz} onTz={saveTz} />
          <div id="s-data"><Data /></div>
          <div id="s-adblock"><AdBlock /></div>
        </main>
      </div>
    </div>
  );
}
