import { href, shortDate, useApi } from "../lib.js";
import { Failed, Loading } from "../ui.jsx";

// Firewall rules (UU-C-270): UniFi's zone-based firewall in plain words. Your own rules in the
// order UniFi checks them (the first that matches decides), how often each blocked something in
// the last 7 days, how the zones treat each other when no rule matches, and UniFi's built-in
// rules. NetLens only reads them; they are changed in UniFi Network.

const when = (t) => (t ? shortDate(t) : "never");
const ACTION = { block: ["Block", "bad"], reject: ["Reject", "bad"], allow: ["Allow", "ok"] };

function Action({ a }) {
  const [label, cls] = ACTION[a] || [a, ""];
  return <span className={`tag ${cls}`}>{label.toUpperCase()}</span>;
}

// "Block the kids network → the apps FaceTime, YouTube · every day 21:00–07:00"
function Sentence({ r }) {
  const extra = [r.port, r.ipVersion, r.only, r.schedule ? `only ${r.schedule}` : null].filter(Boolean);
  return (
    <span>
      <span title={r.from.items.length > 6 ? r.from.items.map((x) => x.name || x).join(", ") : undefined}>{r.from.text}</span>
      <span className="dim"> → </span>
      <span title={r.to.items.length > 6 ? r.to.items.map((x) => x.name || x).join(", ") : undefined}>{r.to.text}</span>
      {extra.length ? <span className="dim"> · {extra.join(" · ")}</span> : null}
    </span>
  );
}

// What a rule (or filter) blocked in the last 7 days. A rule that is off now still shows what
// it blocked while it was on (UU-C-272).
function Blocks({ r, b = r.blocks, enabled = r.enabled }) {
  if (r.action === "allow") return <span className="dim">—</span>;
  if (!b) return <span className="dim">{enabled ? "none seen" : "off"}</span>;
  return (
    <a href={href("security", null, { r: "7d", rule: r.name })} title="Open these blocks on Protection">
      <span className="mono">{b.connections.toLocaleString()}</span> blocked{enabled ? "" : " while on"}
      <div className="small dim">{b.devices} device{b.devices === 1 ? "" : "s"}, {b.incidents} time{b.incidents === 1 ? "" : "s"}{enabled ? "" : " · off now"}</div>
    </a>
  );
}

const ago = (t) => {
  const m = Math.round((Date.now() - t) / 60e3);
  return m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
};

export default function Firewall() {
  const { data: d, error, loading, reload } = useApi("/api/firewall", 5 * 60 * 1000);
  const on = d?.rules.filter((r) => r.enabled).length || 0;
  return (
    <div className="page wide capped">
      <div className="page-head">
        <div className="titles">
          <span className="dim small">Protection · Firewall rules</span>
          <h1>Firewall rules</h1>
          {d && (
            <span className="muted">
              {d.rules.length} of your own ({on} on) · read from UniFi {when(d.at)}
              {d.stale ? <span className="warn"> · not refreshed for a while</span> : null}
            </span>
          )}
        </div>
      </div>
      {error && <Failed error={error} reload={reload} />}
      {!d && loading && <Loading />}
      {d && !d.at && (
        <section className="card">
          <p className="small dim" style={{ margin: 0 }}>NetLens has not read the firewall yet: it reads the rules once an hour from UniFi Network 9 or later (zone-based firewall).</p>
        </section>
      )}
      {d?.at && (
        <>
          <section className="card">
            <div className="card-head">
              <h2>Your rules</h2>
              <span className="hint">UniFi checks them from the top; the first rule that matches a connection decides. Change them in UniFi Network; NetLens only reads them.</span>
            </div>
            {d.rules.length ? (
              <div className="scroll-x">
                <table className="t fw-rules">
                  <thead>
                    <tr>
                      <th className="num">#</th>
                      <th>Rule</th>
                      <th>What it does</th>
                      <th>Last 7 days</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.rules.map((r, i) => (
                      <tr key={r.id} className={r.enabled ? "" : "fw-off"}>
                        <td className="num mono dim">{i + 1}</td>
                        <td>
                          <strong>{r.name || "Unnamed rule"}</strong>
                          <div className="small">{r.enabled ? <span className="ok">on</span> : <span className="dim">off</span>}{r.logging ? <span className="dim"> · logged</span> : null}</div>
                          {r.description && <div className="small dim">{r.description}</div>}
                          {r.fromObject && !/object/i.test(r.description || "") && <div className="small dim">made by UniFi from your Object "{r.fromObject}"</div>}
                        </td>
                        <td>
                          <Action a={r.action} /> <Sentence r={r} />
                          <div className="small dim">{r.from.zone} → {r.to.zone}</div>
                        </td>
                        <td><Blocks r={r} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="small dim" style={{ margin: 0 }}>You have no rules of your own: only UniFi's defaults below apply.</p>
            )}
          </section>

          <section className="card">
            <div className="card-head">
              <h2>Recent changes</h2>
              <span className="hint">What changed in the last 30 days, as NetLens saw it on its hourly read (so up to an hour after it was clicked).</span>
            </div>
            {d.changes?.length ? (
              <ul className="fw-other">
                {d.changes.slice(0, 30).map((c, i) => (
                  <li key={i}>
                    <span className="dim small">{shortDate(c.at)} ({ago(c.at)}) · </span>
                    {c.kind} <strong>{c.name}</strong> {c.what}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="small dim" style={{ margin: 0 }}>No changes seen yet. NetLens notes them from the first read after this update on; earlier changes show only through the blocks they caused.</p>
            )}
          </section>

          <section className="card">
            <div className="card-head">
              <h2>When no rule matches</h2>
              <span className="hint">What UniFi does by default between its zones. "Answers allowed" = connections started from the other side get their replies.</span>
            </div>
            <div className="scroll-x">
              <table className="t fw-matrix">
                <thead>
                  <tr>
                    <th>From ↓ to →</th>
                    {d.matrix.map((z) => <th key={z.zone}>{z.zone}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {d.matrix.map((z) => (
                    <tr key={z.zone}>
                      <th>{z.zone}</th>
                      {z.cells.map((c) => (
                        <td key={c.to} className={c.action === "block" ? "fw-block" : c.action === "allow" ? "fw-allow" : ""}>
                          {c.action === "allow" ? "Allowed" : c.action === "block" ? "Blocked" : "—"}
                          {c.action === "block" && c.answers ? <div className="small dim">answers allowed</div> : null}
                          {c.own ? <div className="small dim">+ {c.own} rule{c.own === 1 ? "" : "s"} of yours</div> : null}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <ul className="small dim fw-zones">
              {d.zones.filter((z) => z.inUse).map((z) => (
                <li key={z.name}><strong>{z.name}</strong>: {z.words}{z.networks.length ? ` (${z.networks.join(", ")})` : ""}</li>
              ))}
              {d.zones.some((z) => !z.inUse) && <li>{d.zones.filter((z) => !z.inUse).map((z) => z.name).join(", ")}: no networks in them, so left out.</li>}
            </ul>
          </section>

          {d.objects?.length ? (
            <section className="card">
              <div className="card-head">
                <h2>Objects</h2>
                <span className="hint">A network or group of devices with its own blocks, routes and speed limits. UniFi turns each into rules.</span>
              </div>
              <div className="scroll-x">
                <table className="t fw-rules">
                  <thead><tr><th>Object</th><th>For</th><th>What it does</th></tr></thead>
                  <tbody>
                    {d.objects.map((o) => (
                      <tr key={o.id} className={o.enabled ? "" : "fw-off"}>
                        <td><strong>{o.name || "Unnamed"}</strong><div className="small">{o.enabled ? <span className="ok">on</span> : <span className="dim">off</span>}</div></td>
                        <td className="small">{o.who.join(", ") || "—"}</td>
                        <td>{o.text}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}

          {d.qos?.length ? (
            <section className="card">
              <div className="card-head">
                <h2>Speed rules</h2>
                <span className="hint">UniFi's QoS: traffic put first, or held to a speed.</span>
              </div>
              <div className="scroll-x">
                <table className="t fw-rules">
                  <thead><tr><th>Rule</th><th>What it does</th></tr></thead>
                  <tbody>
                    {d.qos.map((q) => (
                      <tr key={q.id} className={q.enabled ? "" : "fw-off"}>
                        <td><strong>{q.name || "Unnamed"}</strong><div className="small">{q.enabled ? <span className="ok">on</span> : <span className="dim">off</span>}{q.schedule ? <span className="dim"> · only {q.schedule}</span> : null}</div></td>
                        <td>{q.text}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}

          {d.filters && (
            <section className="card">
              <div className="card-head">
                <h2>Content filters</h2>
                <span className="hint">UniFi answers lookups for these kinds of sites with nothing, so they never load. Not firewall rules, but they block too.</span>
              </div>
              {d.filters.length ? (
                <div className="scroll-x">
                  <table className="t fw-rules">
                    <thead>
                      <tr>
                        <th>Filter</th>
                        <th>Blocks</th>
                        <th>For</th>
                        <th>Exceptions</th>
                        <th>Last 7 days</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.filters.map((f) => (
                        <tr key={f.id} className={f.enabled ? "" : "fw-off"}>
                          <td>
                            <strong>{f.name || "Unnamed filter"}</strong>
                            <div className="small">{f.enabled ? <span className="ok">on</span> : <span className="dim">off</span>}{f.schedule ? <span className="dim"> · only {f.schedule}</span> : null}</div>
                          </td>
                          <td>
                            {f.blocks.join(", ") || "—"}
                            {f.block.length ? <div className="small dim" title={f.block.join(", ")}>and {f.block.length} site{f.block.length === 1 ? "" : "s"} of your own</div> : null}
                            {f.safeSearch.length ? <div className="small dim">safe search: {f.safeSearch.join(", ")}</div> : null}
                          </td>
                          <td className="small">{f.who.join(", ") || <span className="dim">everyone</span>}</td>
                          <td className="small dim">{f.allow.length ? `allowed anyway: ${f.allow.join(", ")}` : "—"}</td>
                          <td><Blocks r={{ name: f.name, action: "block" }} b={f.stopped} enabled={f.enabled} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="small dim" style={{ margin: 0 }}>No content filters.</p>
              )}
            </section>
          )}

          {d.dns && (
            <section className="card">
              <div className="card-head">
                <h2>Your DNS records</h2>
                <span className="hint">Names UniFi answers itself on your network, before asking the internet. Not firewall rules: they send a name to an address.</span>
              </div>
              {d.dns.length ? (
                <div className="scroll-x">
                  <table className="t">
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>Points to</th>
                        <th>Type</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.dns.map((r) => (
                        <tr key={r.id} className={r.enabled ? "" : "fw-off"}>
                          <td className="mono">{r.name}{r.enabled ? null : <span className="small dim"> (off)</span>}</td>
                          <td><span className="mono">{r.value}</span>{r.device ? <span className="small dim"> · {r.device}</span> : null}</td>
                          <td className="small dim">{{ A: "address (IPv4)", AAAA: "address (IPv6)", CNAME: "another name", MX: "mail server", TXT: "text", SRV: "service" }[r.type] || r.type}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="small dim" style={{ margin: 0 }}>No DNS records of your own.</p>
              )}
            </section>
          )}

          {d.other?.length ? (
            <section className="card">
              <div className="card-head">
                <h2>Checked too</h2>
                <span className="hint">The rest of UniFi's Policy Engine, so nothing is left out.</span>
              </div>
              <ul className="fw-other">
                {d.other.map((g) => (
                  <li key={g.kind}>
                    <strong>{g.kind}</strong> <span className="small dim">· {g.note}</span>
                    {!g.read ? (
                      <span className="small dim"> · not available on this UniFi version</span>
                    ) : g.items.length ? (
                      <ul>
                        {g.items.map((x) => (
                          <li key={x.id} className={x.enabled ? "" : "fw-off"}>
                            {x.name ? <strong>{x.name}: </strong> : null}
                            {x.text}
                            {x.schedule ? <span className="dim"> · only {x.schedule}</span> : null}
                            {x.enabled ? null : <span className="dim"> (off)</span>}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <span className="small dim"> · none</span>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <details className="card">
            <summary><h2 style={{ display: "inline" }}>UniFi's built-in rules</h2> <span className="hint">{d.builtin.length} between the zones you use, checked after yours</span></summary>
            <div className="scroll-x">
              <table className="t">
                <thead>
                  <tr>
                    <th>Rule</th>
                    <th>What it does</th>
                    <th>Why</th>
                  </tr>
                </thead>
                <tbody>
                  {d.builtin.map((r) => (
                    <tr key={r.id} className={r.enabled ? "" : "fw-off"}>
                      <td>{r.name}<div className="small dim">{r.from.zone} → {r.to.zone}</div></td>
                      <td><Action a={r.action} /> <Sentence r={r} /></td>
                      <td className="small dim">{r.note || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
    </div>
  );
}
