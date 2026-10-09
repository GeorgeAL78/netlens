import { useEffect, useState } from "react";
import "./sidenav.css";

// One side menu for both releases. v1 and v2 are separate bundles, so the only way to
// keep their navigation genuinely identical is to share the component and its stylesheet
// rather than maintain two copies that drift.
//
// Everything is passed in: the two views differ in what they can do (v2 has no Settings
// modal of its own until one is wired), and a missing handler simply hides that item
// rather than rendering a dead button.
export default function SideNav({
  open = false,
  onClose,
  view = "classic",
  statusText = "",
  warming = false,
  gaps = 0,
  busy = false,
  onFetchNew,
  onBackfill,
  onRefetchAll,
  onReload,
  onOpenSettings,
  trayMode = false,
  onToggleTray,
  onMinimize,
  onQuit,
  classicHref = "./index.html",
  timelineHref = "./v2/index.html",
}) {
  const disabled = busy || warming;
  // The running version (UU-C-084), from the health check — open even before login.
  const [version, setVersion] = useState("");
  useEffect(() => {
    fetch("/healthz")
      .then((r) => r.json())
      .then((j) => setVersion(j.version || ""))
      .catch(() => {});
  }, []);
  return (
    <>
      {open && <div className="sn-scrim" onClick={onClose} />}
      <aside className={`sn ${open ? "open" : ""}`}>
        <div className="sn-brand">
          <span className="sn-mark" aria-hidden="true" />
          <div>
            <strong>NetLens</strong>
            <span className="sn-dim">
              for UniFi{version ? ` · ${/^\d/.test(version) ? `v${version}` : version}` : ""}
            </span>
          </div>
        </div>

        <div className="sn-status">
          <span className={`sn-pulse ${warming ? "busy" : "ok"}`} />
          {statusText}
        </div>

        <nav className="sn-group">
          <p className="sn-label">Data</p>
          {onFetchNew && (
            <button className="sn-item primary" disabled={disabled} onClick={onFetchNew}>
              {busy ? "Fetching…" : "Fetch new data"}
            </button>
          )}
          {gaps > 0 && onBackfill && (
            <button className="sn-item" disabled={disabled} onClick={onBackfill}>
              {`Fetch ${gaps} missing day${gaps === 1 ? "" : "s"}`}
            </button>
          )}
          {onRefetchAll && (
            <button className="sn-item" disabled={disabled} onClick={onRefetchAll}>
              Refetch everything
            </button>
          )}
          {onReload && (
            <button className="sn-item" onClick={onReload}>
              Reload from cache
            </button>
          )}
        </nav>

        <nav className="sn-group">
          <p className="sn-label">View</p>
          {view === "classic" ? (
            <span className="sn-item current">Classic</span>
          ) : (
            <a className="sn-item" href={classicHref}>
              Classic
            </a>
          )}
          {view === "timeline" ? (
            <span className="sn-item current">Timeline</span>
          ) : (
            <a className="sn-item" href={timelineHref}>
              Timeline
            </a>
          )}
        </nav>

        <nav className="sn-group">
          <p className="sn-label">Settings</p>
          {onOpenSettings && (
            <button className="sn-item" onClick={onOpenSettings}>
              Settings…
            </button>
          )}
          {onToggleTray && (
            <button className="sn-item" onClick={() => onToggleTray(!trayMode)}>
              <span className={`sn-check ${trayMode ? "on" : ""}`} />
              Run in background
            </button>
          )}
        </nav>

        <div className="sn-foot">
          {onMinimize && (
            <button className="sn-item" onClick={onMinimize}>
              Minimize to tray
            </button>
          )}
          {onQuit && (
            <button className="sn-item danger" onClick={onQuit}>
              Exit
            </button>
          )}
        </div>
      </aside>
    </>
  );
}
