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
  ["access", "API & AI"],
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
  // How often NetLens reads UniFi (UU-C-144).
  const [every, setEvery] = useState("");
  useEffect(() => {
    if (data?.snapshotMinutes && every === "") setEvery(String(data.snapshotMinutes));
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps
  async function saveEvery() {
    setMsg("");
    try {
      const r = await api("/api/settings", { method: "PUT", body: JSON.stringify({ snapshotMinutes: every }) });
      setEvery(String(r.snapshotMinutes));
      setMsg(`NetLens now reads UniFi every ${r.snapshotMinutes} minute${r.snapshotMinutes === 1 ? "" : "s"}.`);
      reload();
    } catch (err) {
      setMsg(err.message);
    }
  }
  // Network map grouping (UU-C-165).
  const [group, setGroup] = useState(null);
  useEffect(() => {
    api("/api/settings").then((x) => setGroup(x.groupGuests !== false)).catch(() => {});
  }, []);
  async function saveGroup(v) {
    setGroup(v);
    await api("/api/settings", { method: "PUT", body: JSON.stringify({ groupGuests: v }) }).catch(() => {});
  }
  return (
    <SettingsSection icon="sliders" title="Updates" hint="How often NetLens reads UniFi by itself, and buttons for catching up by hand. UniFi keeps time detail in 5-minute steps, so reading more often only makes the newest numbers fresher.">
      <div className="setup-row">
        <label>
          Read UniFi every (minutes)
          <input inputMode="numeric" value={every} onChange={(e) => setEvery(e.target.value.replace(/\D/g, ""))} placeholder="5" disabled={!data} />
        </label>
        <div style={{ alignSelf: "flex-end" }}>
          <button type="button" className="btn primary" onClick={saveEvery} disabled={!data || !every || every === String(data?.snapshotMinutes)}>Save</button>
        </div>
      </div>
      <label className="small" style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
        <input type="checkbox" checked={group !== false} disabled={group == null} onChange={(e) => saveGroup(e.target.checked)} />
        On the Network map, put virtual machines and containers under the device that runs them
      </label>
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

// A read-only access key for scripts and assistants (UU-C-204). Shown once; replacing it or
// turning it off stops the old one at once.
function AccessKey() {
  const [s, setS] = useState(null);
  const [key, setKey] = useState("");
  const [msg, setMsg] = useState("");
  // Read only, or read and the safe changes (UU-C-227).
  const [scope, setScope] = useState("read");
  useEffect(() => {
    api("/api/settings").then((x) => {
      setS(x);
      if (x.accessKeyScope) setScope(x.accessKeyScope);
    }).catch((e) => setMsg(e.message));
  }, []);
  async function make() {
    if (s?.accessKeyCreated && !window.confirm("Replace the access key? The old one stops working at once.")) return;
    setMsg("");
    try {
      const r = await api("/api/access-key", { method: "POST", body: JSON.stringify({ scope }) });
      setKey(r.key);
      setS((x) => ({ ...x, accessKeyCreated: r.created, accessKeyScope: r.scope }));
    } catch (e) {
      setMsg(e.message);
    }
  }
  async function remove() {
    if (!window.confirm("Turn the access key off? Anything using it loses access at once.")) return;
    setMsg("");
    try {
      await api("/api/access-key", { method: "DELETE" });
      setKey("");
      setS((x) => ({ ...x, accessKeyCreated: null, accessKeyScope: null }));
      setMsg("Access key turned off.");
    } catch (e) {
      setMsg(e.message);
    }
  }
  const noLogin = s && !s.hasPassword;
  const origin = window.location.origin;
  const scopeText = (sc) => (sc === "full" ? "read and make safe changes" : "read only");
  return (
    <SettingsSection icon="shield" title="API and AI access" hint="Lets a script or an AI assistant use NetLens: every page's data as JSON, and with a full key the safe changes — rename a device, set where a VM runs, check a device, manage alerts, hide findings, refresh. No key can block devices, change settings, the password or this key, or import or export history.">
      <div className="kv">
        <div><span>MCP (Claude and other assistants)</span><span className="mono">{origin}/mcp</span></div>
        <div><span>REST, described</span><span className="mono"><a href="/api/openapi.json" target="_blank" rel="noreferrer">{origin}/api/openapi.json</a></span></div>
      </div>
      {noLogin ? (
        <p className="setup-dim">There is no login password, so the API and the MCP endpoint are open to anyone on your network, with the safe changes. Set a password to require a key.</p>
      ) : (
        <>
          <p className="setup-dim">Send the key as the header Authorization: Bearer &lt;key&gt; — in an assistant, add a custom connector with the MCP address above and that header. {!s ? "…" : s.accessKeyCreated ? `A key is on (${scopeText(s.accessKeyScope)}), made ${new Date(s.accessKeyCreated).toLocaleDateString()}.` : "No key yet."}</p>
          <div className="seg" role="radiogroup" aria-label="What the key may do">
            <button type="button" role="radio" aria-checked={scope === "read"} className={scope === "read" ? "on" : ""} onClick={() => setScope("read")}>Read only</button>
            <button type="button" role="radio" aria-checked={scope === "full"} className={scope === "full" ? "on" : ""} onClick={() => setScope("full")}>Read and safe changes</button>
          </div>
          {key && (
            <div className="setup-row">
              <label>
                Your key — copy it now, it is not shown again
                <input readOnly value={key} onFocus={(e) => e.target.select()} />
              </label>
            </div>
          )}
          <div className="account-actions">
            <button type="button" className="btn primary" onClick={make} disabled={!s}>{s?.accessKeyCreated ? (s.accessKeyScope === scope ? "Replace key" : `Replace with a ${scope === "full" ? "full" : "read-only"} key`) : "Make a key"}</button>
            {key && navigator.clipboard && <button type="button" className="btn" onClick={() => navigator.clipboard.writeText(key).then(() => setMsg("Copied."))}>Copy</button>}
            {s?.accessKeyCreated && <button type="button" className="btn" onClick={remove}>Turn off</button>}
          </div>
        </>
      )}
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
          <div id="s-access"><AccessKey /></div>
        </main>
      </div>
    </div>
  );
}
