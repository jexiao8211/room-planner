import { useEffect, useState } from "react";
import type { HealthResponse } from "../shared/types";
import { getHealth, isAbort } from "./api";

type Health =
  | { state: "loading" }
  | { state: "ok"; mode: HealthResponse["mode"]; provider?: HealthResponse["provider"] }
  | { state: "offline" };

/** Polls /api/health once on load (and on retry). */
function useHealth(): [Health, () => void] {
  const [health, setHealth] = useState<Health>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const ctrl = new AbortController();
    getHealth(ctrl.signal)
      .then((h) => setHealth({ state: "ok", mode: h.mode, provider: h.provider }))
      .catch((e) => {
        if (!isAbort(e)) setHealth({ state: "offline" });
      });
    return () => ctrl.abort();
  }, [attempt]);
  return [health, () => setAttempt((a) => a + 1)];
}

export function ModeBanner() {
  const [health, retry] = useHealth();
  const [dismissed, setDismissed] = useState(false);
  if (health.state === "offline") {
    return (
      <div className="banner banner-error" data-testid="mode-banner" data-mode="offline" role="alert">
        <strong>API offline — run npm run dev</strong>
        <span className="banner-sub">Photo analysis and product search need the local server. You can still plan by hand.</span>
        <button className="banner-btn" data-testid="health-retry-btn" onClick={retry}>
          Retry
        </button>
      </div>
    );
  }
  if (health.state !== "ok" || dismissed) return null;
  if (health.mode === "mock") {
    return (
      <div className="banner banner-info" data-testid="mode-banner" data-mode="mock" role="status">
        <strong>Demo mode</strong>
        <span className="banner-sub">
          Demo data is on because MOCK_AI or AI_PROVIDER=mock is set. Remove it (and restart) for real photo analysis
          and product search with your Claude subscription (signed-in Claude Code) or an ANTHROPIC_API_KEY.
        </span>
        <button className="banner-btn" aria-label="Dismiss banner" onClick={() => setDismissed(true)}>
          Dismiss
        </button>
      </div>
    );
  }
  if (health.provider === "subscription") {
    return (
      <div className="banner banner-info banner-slim" data-testid="mode-banner" data-mode="subscription" role="status">
        <span className="banner-sub">Using your Claude subscription (Agent SDK credit)</span>
        <button className="banner-btn" aria-label="Dismiss banner" onClick={() => setDismissed(true)}>
          Dismiss
        </button>
      </div>
    );
  }
  return null;
}
