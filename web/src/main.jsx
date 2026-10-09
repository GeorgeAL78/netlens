import React, { Component } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import { SetupGate } from "./shared/Setup.jsx";
import "./styles.css";

class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    const root =
      window.location.protocol === "file:" || window.unifiDesktop?.isDesktop
        ? "http://127.0.0.1:3780"
        : "";
    fetch(`${root}/api/log`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: "react",
        message: error?.message,
        stack: error?.stack,
        extra: info?.componentStack,
      }),
    }).catch(() => {});
  }
  render() {
    if (this.state.error) {
      return (
        <div className="app">
          <h1>NetLens</h1>
          <p className="error">{String(this.state.error.message || this.state.error)}</p>
          <button className="btn" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById("root")).render(
  <ErrorBoundary>
    <SetupGate>
      <App />
    </SetupGate>
  </ErrorBoundary>
);

function reportClientError(source, message, extra) {
  const root =
    window.location.protocol === "file:" || window.unifiDesktop?.isDesktop
      ? "http://127.0.0.1:3780"
      : "";
  fetch(`${root}/api/log`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source, message, extra }),
  }).catch(() => {});
}

window.addEventListener("error", (event) => {
  reportClientError("window.onerror", event.error?.stack || event.message);
});
window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason;
  reportClientError("unhandledrejection", reason?.stack || String(reason));
});
