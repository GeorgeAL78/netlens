import { useEffect, useMemo, useState } from "react";
import "./setup.css";

// First-run setup, the gate that shows it, and the account part of Settings (UU-C-059).
// Connection settings and the login password live in the app's database and are managed
// here — not in Docker variables.

const browserTz = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

function timezones(current) {
  let list = [];
  try {
    list = Intl.supportedValuesOf("timeZone");
  } catch {
    list = [];
  }
  return [...new Set([current, browserTz(), "UTC", ...list].filter(Boolean))].sort();
}

async function call(path, body, method = "POST") {
  const res = await fetch(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || res.statusText);
  return json;
}

export function TimezoneSelect({ value, onChange }) {
  const options = useMemo(() => timezones(value), [value]);
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      {options.map((z) => (
        <option key={z} value={z}>
          {z}
        </option>
      ))}
    </select>
  );
}

function Setup({ settings }) {
  const [host, setHost] = useState(settings.host || "192.168.1.1");
  const [apiKey, setApiKey] = useState("");
  const [site, setSite] = useState(settings.site || "default");
  const [tz, setTz] = useState(settings.tz || browserTz());
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const needKey = !settings.hasApiKey;
  const needPassword = !settings.hasPassword;

  async function submit(e) {
    e.preventDefault();
    setError("");
    // Read the fields themselves: a browser that auto-fills a password does not always tell
    // React, which made a 9-character password fail the 8-character check.
    const form = new FormData(e.currentTarget);
    const pw = String(form.get("password") ?? password);
    const pw2 = String(form.get("confirm") ?? confirm);
    // Run without a login (UU-C-082): both fields left empty, then confirmed — never silently.
    let noLogin = false;
    if (needPassword) {
      if (!pw && !pw2) {
        if (!window.confirm("Continue without a password? Anyone on your network can open NetLens and block devices. You can set one later in Settings.")) return;
        noLogin = true;
      } else {
        if (settings.serverMode && pw.length < 8) return setError("Choose a login password of at least 8 characters, or leave both fields empty to skip it.");
        if (pw !== pw2) return setError("The two passwords do not match.");
      }
    }
    setBusy(true);
    try {
      const payload = { host, site, tz };
      if (apiKey) payload.apiKey = apiKey;
      await call("/api/settings", payload, "PUT");
      if (needPassword && noLogin) await call("/api/login-mode", { disabled: true });
      else if (pw) await call("/api/password", { password: pw });
      // Prove the connection before leaving the setup screen.
      const res = await fetch("/api/clients?scope=online");
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(`Saved, but UniFi did not answer: ${j.error || res.statusText}. Check the host and API key.`);
      }
      window.location.reload();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <div className="setup-wrap">
      <form className="setup" onSubmit={submit}>
        <img src="./favicon.png" alt="" className="setup-logo" onError={(e) => (e.currentTarget.style.display = "none")} />
        <h1>Welcome to NetLens</h1>
        <p className="setup-dim">Connect it to your UniFi console. Everything here can be changed later in Settings.</p>

        <label>
          UniFi console (IP or hostname)
          <input value={host} onChange={(e) => setHost(e.target.value)} required placeholder="192.168.1.1" />
        </label>
        <label>
          API key
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            required={needKey}
            placeholder={needKey ? "Paste your UniFi API key" : "Stored — leave blank to keep"}
            autoComplete="off"
          />
          <span className="setup-hint">
            UniFi Network → Settings → Control Plane → Integrations → Create API Key. UniFi shows it only once.
          </span>
        </label>
        <div className="setup-row">
          <label>
            Site
            <input value={site} onChange={(e) => setSite(e.target.value)} placeholder="default" />
          </label>
          <label>
            Timezone
            <TimezoneSelect value={tz} onChange={setTz} />
          </label>
        </div>

        {needPassword && (
          <>
            <h2>Login password</h2>
            <p className="setup-dim">
              Recommended: without one, anyone on your network can open the dashboard and block devices. Leave both
              fields empty to skip it.
            </p>
            <div className="setup-row">
              <label>
                Password
                <input name="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
              </label>
              <label>
                Repeat
                <input name="confirm" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
              </label>
            </div>
          </>
        )}

        {error && <div className="setup-error">{error}</div>}
        <button type="submit" disabled={busy}>
          {busy ? "Connecting…" : "Save and start"}
        </button>
      </form>
    </div>
  );
}

// Shows the setup on first run; otherwise renders the app. A 401 means a password exists
// and this browser is not logged in.
export function SetupGate({ children }) {
  const [settings, setSettings] = useState(null);
  useEffect(() => {
    fetch("/api/settings")
      .then((r) => {
        if (r.status === 401) {
          window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;
          return null;
        }
        return r.json();
      })
      .then((s) => s && setSettings(s))
      .catch(() => setSettings({ needsSetup: false }));
  }, []);
  if (!settings) return null;
  if (settings.needsSetup) return <Setup settings={settings} />;
  return children;
}

// ---- Settings dialog building blocks (UU-C-076) ----------------------------------------
const ICONS = {
  console: "M4 6h16v5H4zM4 13h16v5H4zM7 8.5h.01M7 15.5h.01",
  clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2",
  lock: "M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3",
  archive: "M4 5h16v4H4zM5.5 9v10h13V9M10 13h4",
  shield: "M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z",
  sliders: "M4 7h9M17 7h3M15 5v4M4 17h3M11 17h9M9 15v4",
};

export function SettingsIcon({ name, size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICONS[name] || ICONS.sliders} />
    </svg>
  );
}

// One titled block of the Settings dialog: icon, title, a one-line hint, then its fields.
export function SettingsSection({ icon, title, hint, children }) {
  return (
    <section className="account set-section">
      <div className="set-section-head">
        <span className="set-icon">
          <SettingsIcon name={icon} />
        </span>
        <div>
          <h3>{title}</h3>
          {hint && <p>{hint}</p>}
        </div>
      </div>
      {children}
    </section>
  );
}

// Timezone, login password and log out — the account half of the Settings dialog.
export function AccountSettings({ tz, onTz }) {
  const [info, setInfo] = useState(null);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [msg, setMsg] = useState("");
  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then(setInfo)
      .catch(() => {});
  }, []);

  async function change() {
    setMsg("");
    if (next !== confirm) return setMsg("The two passwords do not match.");
    try {
      await call("/api/password", { current, password: next });
      setCurrent("");
      setNext("");
      setConfirm("");
      setInfo((i) => ({ ...i, hasPassword: true }));
      setMsg("Password saved. Other browsers are signed out.");
    } catch (err) {
      setMsg(err.message);
    }
  }

  async function logout() {
    await call("/api/logout", {}).catch(() => {});
    window.location.href = "/login";
  }

  // Run without a login from now on (UU-C-082); needs the current password.
  async function removePassword() {
    setMsg("");
    if (!window.confirm("Remove the password? Anyone on your network will be able to open NetLens and block devices.")) return;
    try {
      await call("/api/password/remove", { current });
      setCurrent("");
      setInfo((i) => ({ ...i, hasPassword: false, loginDisabled: true }));
      setMsg("Password removed. NetLens now opens without a login.");
    } catch (err) {
      setMsg(err.message);
    }
  }

  return (
    <>
      <SettingsSection icon="clock" title="General" hint="Days, hours and charts follow this timezone.">
        <label>
          Timezone
          <TimezoneSelect value={tz || info?.tz || browserTz()} onChange={onTz} />
        </label>
      </SettingsSection>
      <SettingsSection
        icon="lock"
        title="Login"
        hint={
          info?.hasPassword
            ? "Change the password, remove it, or sign out of this browser."
            : info?.loginDisabled
              ? "No password: anyone on your network can open NetLens and block devices. Set one here to require a login."
              : "Set a password to protect the dashboard."
        }
      >
      {info?.hasPassword && (
        <label>
          Current password
          <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
        </label>
      )}
      <div className="setup-row">
        <label>
          {info?.hasPassword ? "New password" : "Password"}
          <input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
        </label>
        <label>
          Repeat
          <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
        </label>
      </div>
      <div className="account-actions">
        <button type="button" className="btn ghost" disabled={!next} onClick={change}>
          {info?.hasPassword ? "Change password" : "Set password"}
        </button>
        {info?.hasPassword && (
          <button type="button" className="btn ghost" onClick={logout}>
            Log out
          </button>
        )}
        {info?.hasPassword && (
          <button type="button" className="btn ghost" disabled={!current} onClick={removePassword} title="Enter the current password first">
            Remove password
          </button>
        )}
      </div>
      {msg && <p className="setup-dim">{msg}</p>}
      </SettingsSection>
      <HistoryTransfer />
    </>
  );
}

// Settings > History (UU-C-066): download everything this installation has saved, or merge
// a file from another installation (or an older backup of this one).
function HistoryTransfer() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  async function upload(file) {
    if (!file) return;
    setBusy(true);
    setMsg(`Importing ${file.name}…`);
    try {
      const r = await fetch("/api/history/import", {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: file,
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `Import failed (${r.status})`);
      const d = j.days || {};
      const added = Object.values(j.rows || {}).reduce((n, v) => n + v, 0);
      const parts = [
        `${d.added || 0} day(s) added`,
        d.replaced ? `${d.replaced} replaced with a fuller copy` : null,
        d.kept ? `${d.kept} kept (this installation's copy was fuller)` : null,
        d.old ? `${d.old} older than ${j.retainDays} days skipped` : null,
        d.busy ? `${d.busy} skipped while being fetched — import again later` : null,
        d.bad ? `${d.bad} unreadable` : null,
        `${added.toLocaleString()} event/sample rows added`,
      ].filter(Boolean);
      setMsg(`Done: ${parts.join(", ")}. Reload to see it.`);
    } catch (err) {
      setMsg(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <SettingsSection
      icon="archive"
      title="History"
      hint="Back up, restore or move everything this installation has saved. Import merges: missing days are added, a day is replaced only by a fuller copy. Settings, the API key and the password are never in the file."
    >
      <div className="account-actions">
        <a className="btn ghost" href="/api/history/export" download>
          Export history
        </a>
        <label className="btn ghost history-import">
          {busy ? "Importing…" : "Import history…"}
          <input
            type="file"
            accept=".gz,.ndjson,application/gzip"
            disabled={busy}
            onChange={(e) => {
              upload(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
        </label>
      </div>
      {msg && <p className="setup-dim">{msg}</p>}
    </SettingsSection>
  );
}
