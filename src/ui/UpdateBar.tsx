// Slim bar shown while a newer version of the app waits for a safe moment to reload (see autoUpdate.ts).
import { reloadNow, useUpdateStatus } from "./autoUpdate";
import { BLOCKER_TEXT } from "./updateDecision";

export function UpdateBar() {
  const show = useUpdateStatus((s) => s.ready && s.showBar);
  const reason = useUpdateStatus((s) => s.blockers[0]);
  const stuck = useUpdateStatus((s) => s.stuck);
  const justUpdated = useUpdateStatus((s) => s.justUpdated);
  if (!show) {
    // Right after an automatic reload: say why the page just redrew itself.
    return justUpdated ? (
      <div className="banner banner-info banner-slim update-bar update-done" data-testid="update-done" role="status">
        <span className="banner-sub">Updated to the latest version of the app. Your room, chat and view are as you left them.</span>
      </div>
    ) : null;
  }
  return (
    <div className="banner banner-info banner-slim update-bar" data-testid="update-bar" data-reason={reason ?? ""} role="status">
      <span className="banner-sub">
        {stuck
          ? "An app update is published but didn't load (it may still be being copied)"
          : `App update ready — applying when you're done${reason ? ` (${BLOCKER_TEXT[reason]})` : ""}`}
      </span>
      <button type="button" className="banner-btn" data-testid="update-now" onClick={reloadNow} title="Reload now; the plan, the chat and your draft are kept">
        Update now
      </button>
    </div>
  );
}
