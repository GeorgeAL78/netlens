import React from "react";
import { createRoot } from "react-dom/client";
import App2 from "./App2.jsx";
import { SetupGate } from "../shared/Setup.jsx";
import "./v2.css";

class Boundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Same contract as v1: a render crash is reported rather than leaving a blank
    // window, and it is posted to the server log so it survives a reload.
    try {
      fetch("/api/log", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: "ui-v2", message: String(error), stack: info?.componentStack }),
      }).catch(() => {});
    } catch {
      /* logging must never mask the original error */
    }
  }

  render() {
    if (this.state.error) {
      return (
        <div className="crash">
          <h1>Something broke in v2</h1>
          <p>{String(this.state.error)}</p>
          <p>
            <a href="../index.html">Back to the classic view</a>
          </p>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById("root")).render(
  <Boundary>
    <SetupGate>
      <App2 />
    </SetupGate>
  </Boundary>
);
