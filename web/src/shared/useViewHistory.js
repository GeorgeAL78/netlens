import { useCallback, useEffect, useRef, useState } from "react";

// Makes each filter change a step in the window's history, so "Back" undoes the last
// one. Riding the real history (rather than a private stack) means the mouse's back
// button and Alt+Left behave the same as the on-screen button.
//
//   view  — the filter state to remember, as a plain object
//   apply — puts a remembered view back
//   track — which keys count as a new step. Leave out anything that changes per
//           keystroke (a search box), or every letter becomes a step.
export function useViewHistory(view, apply, track = Object.keys(view)) {
  const key = JSON.stringify(track.map((k) => view[k]));
  const last = useRef(null);
  const restoring = useRef(null);
  const applyRef = useRef(apply);
  applyRef.current = apply;
  const [depth, setDepth] = useState(0);

  useEffect(() => {
    if (restoring.current === key) {
      restoring.current = null;
      last.current = key;
      return;
    }
    const d = Number(window.history.state?.uuDepth || 0);
    if (last.current === null) {
      window.history.replaceState({ uuView: view, uuDepth: d }, "");
      setDepth(d);
    } else if (last.current !== key) {
      window.history.pushState({ uuView: view, uuDepth: d + 1 }, "");
      setDepth(d + 1);
    }
    last.current = key;
    // `view` is covered by `key`; depending on the object itself would fire every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    const onPop = (e) => {
      const v = e.state?.uuView;
      if (!v) return;
      setDepth(Number(e.state.uuDepth || 0));
      const next = JSON.stringify(track.map((k) => v[k]));
      // Only arm the guard if something will actually change — otherwise the effect
      // never runs to clear it, and the next real change would be swallowed.
      if (next !== last.current) restoring.current = next;
      applyRef.current(v);
    };
    // Electron does not map the mouse's side buttons or Alt+arrows to navigation, so
    // wire them here.
    const onMouse = (e) => {
      if (e.button === 3) { e.preventDefault(); window.history.back(); }
      if (e.button === 4) { e.preventDefault(); window.history.forward(); }
    };
    const onKey = (e) => {
      if (!e.altKey) return;
      if (e.key === "ArrowLeft") { e.preventDefault(); window.history.back(); }
      if (e.key === "ArrowRight") { e.preventDefault(); window.history.forward(); }
    };
    window.addEventListener("popstate", onPop);
    window.addEventListener("mouseup", onMouse);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("popstate", onPop);
      window.removeEventListener("mouseup", onMouse);
      window.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const back = useCallback(() => window.history.back(), []);
  return { canGoBack: depth > 0, back };
}
