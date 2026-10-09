import React, { Component } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import { SetupGate } from "./shared/Setup.jsx";
import "./app.css";

class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    fetch("/api/log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: "react", message: error?.message, stack: error?.stack, extra: info?.componentStack }),
    }).catch(() => {});
  }
  render() {
    if (this.state.error) {
      return (
        <div className="page narrow">
          <h1>Something went wrong</h1>
          <p className="error">{String(this.state.error.message || this.state.error)}</p>
          <div>
            <button className="btn" onClick={() => window.location.reload()}>
              Reload
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <ErrorBoundary>
      <SetupGate>
        <App />
      </SetupGate>
    </ErrorBoundary>
  </React.StrictMode>
);
