// Room design versions: the toolbar "Versions" button and its drawer (save, restore, rename, duplicate, delete,
// export all). The store lives in src/state/versions.ts.
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { DesignVersion } from "../shared/types";
import { usePlanner } from "../state/store";
import {
  exportAllJSON,
  hasUnsavedChanges,
  nextVersionName,
  setThumbnailProvider,
  startAutoVersions,
  useVersions,
} from "../state/versions";
import { captureThumbnail } from "../scene";
import { Icon } from "./icons";
import "./versions.css";

setThumbnailProvider(() => captureThumbnail());

function HistoryIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 12a9 9 0 1 0 3-6.7" />
      <path d="M3 4v5h5" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

function timeAgo(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d} day${d === 1 ? "" : "s"} ago`;
  return new Date(at).toLocaleDateString();
}

/** Clock time of a version, with the weekday when it isn't today ("9:41 AM", "Sat 9:41 AM"). */
export function clockTime(at: number, now: number): string {
  const d = new Date(at);
  const today = new Date(now).toDateString() === d.toDateString();
  return d.toLocaleString([], today ? { hour: "numeric", minute: "2-digit" } : { weekday: "short", hour: "numeric", minute: "2-digit" });
}

/** `value`, updated at most every `ms` (the unsaved-changes check stringifies the whole plan; not on every drag frame). */
function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function download(filename: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Toolbar button that opens the versions drawer. Also runs the periodic auto snapshot while the app is open. */
export function VersionsButton() {
  const [open, setOpen] = useState(false);
  const count = useVersions((s) => s.versions.length);
  useEffect(() => startAutoVersions(), []);
  return (
    <>
      <button
        className={`btn btn-ghost${open ? " versions-btn-open" : ""}`}
        data-testid="versions-btn"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label="Versions"
        title="Saved versions of this design"
        onClick={() => setOpen((o) => !o)}
      >
        <HistoryIcon /> <span className="versions-label">Versions</span>
        {count ? <span className="versions-count">{count}</span> : null}
      </button>
      {open && typeof document !== "undefined" ? createPortal(<VersionsPanel onClose={() => setOpen(false)} />, document.body) : null}
    </>
  );
}

function VersionsPanel({ onClose }: { onClose: () => void }) {
  const versions = useVersions((s) => s.versions);
  const storageNote = useVersions((s) => s.storageNote);
  const baseline = useVersions((s) => s.baseline);
  const liveRoom = usePlanner((s) => s.room);
  const liveItems = usePlanner((s) => s.items);
  const plan = useMemo(() => ({ room: liveRoom, items: liveItems }), [liveRoom, liveItems]);
  const { room, items } = useDebounced(plan, 300);
  const unsaved = useMemo(() => hasUnsavedChanges({ room, items }, versions, baseline), [room, items, versions, baseline]);
  // Named versions first (they are the options the owner made), then the automatic ones, newest first in each.
  const named = versions.filter((v) => !v.auto);
  const autos = versions.filter((v) => v.auto);
  const defaultName = nextVersionName(versions.filter((v) => !v.auto));
  const [name, setName] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => setNow(Date.now()), [versions]);
  useEffect(() => {
    if (!confirmDelete) return;
    const t = setTimeout(() => setConfirmDelete(null), 4000);
    return () => clearTimeout(t);
  }, [confirmDelete]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (renaming) setRenaming(null);
      else onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [renaming, onClose]);

  const save = () => {
    const v = useVersions.getState().saveVersion(name.trim() || undefined);
    setName("");
    setMessage(`Saved “${v.name}”.`);
  };

  const restore = (v: DesignVersion) => {
    const newestBefore = useVersions.getState().versions[0]?.id;
    useVersions.getState().restoreVersion(v.id);
    const newest = useVersions.getState().versions[0];
    const kept = newest && newest.id !== newestBefore && newest.auto ? ` Your previous design is kept as “${newest.name}”.` : "";
    setMessage(`Restored “${v.name}” (Ctrl+Z undoes it).${kept}`);
  };

  const commitRename = () => {
    if (renaming && renaming.name.trim()) useVersions.getState().renameVersion(renaming.id, renaming.name);
    setRenaming(null);
  };

  const remove = (v: DesignVersion) => {
    if (confirmDelete !== v.id) {
      setConfirmDelete(v.id);
      return;
    }
    setConfirmDelete(null);
    useVersions.getState().deleteVersion(v.id);
    setMessage(`Deleted “${v.name}”.`);
  };

  return (
    <div className="versions-panel" role="dialog" aria-label="Design versions" data-testid="versions-panel" ref={panelRef}>
      <div className="versions-head">
        <div>
          <div className="eyebrow">Design</div>
          <h2 className="versions-title">Versions</h2>
        </div>
        <button className="btn btn-icon btn-sm" data-testid="versions-close" aria-label="Close versions" title="Close (Esc)" onClick={onClose}>
          <Icon.close />
        </button>
      </div>

      <form
        className="versions-save"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <input
          className="input"
          data-testid="version-name-input"
          aria-label="Version name"
          placeholder={defaultName}
          maxLength={80}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <button className="btn btn-primary" type="submit" data-testid="version-save-btn" title="Save the current design as a version">
          Save current
        </button>
      </form>

      {message ? (
        <div className="inline-msg small versions-msg" data-testid="versions-message" role="status">
          {message}
        </div>
      ) : null}
      {storageNote ? (
        <div className="inline-msg warn small versions-msg" data-testid="versions-storage-note" role="alert">
          {storageNote}
        </div>
      ) : null}

      <ul className="versions-list" aria-label="Saved versions">
        {unsaved ? (
          <li className="version-row version-current" data-testid="versions-current">
            <div className="version-thumb version-thumb-empty" aria-hidden="true">
              <HistoryIcon />
            </div>
            <div className="version-body">
              <div className="version-name">Current (unsaved changes)</div>
              <div className="version-meta">
                {items.length} item{items.length === 1 ? "" : "s"} · {versions.length ? "differs from the newest version" : "nothing saved yet"}
              </div>
            </div>
          </li>
        ) : null}
        {named.length && autos.length ? <li className="versions-group eyebrow" aria-hidden="true">Saved</li> : null}
        {[...named, ...autos].map((v, i) => [
          named.length && autos.length && i === named.length ? (
            <li key="auto-head" className="versions-group eyebrow" aria-hidden="true">
              Automatic
            </li>
          ) : null,
          <li key={v.id} className="version-row" data-testid="version-row" data-auto={v.auto ? "true" : "false"} data-name={v.name}>
            {v.thumbnail ? (
              <img className="version-thumb" src={v.thumbnail} alt="" data-testid="version-thumb" />
            ) : (
              <div className="version-thumb version-thumb-empty" aria-hidden="true">
                <HistoryIcon />
              </div>
            )}
            <div className="version-body">
              {renaming?.id === v.id ? (
                <input
                  className="input input-sm"
                  data-testid="version-rename-input"
                  aria-label="New version name"
                  autoFocus
                  maxLength={80}
                  value={renaming.name}
                  onChange={(e) => setRenaming({ id: v.id, name: e.target.value })}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitRename();
                  }}
                />
              ) : (
                <div className="version-name" title={v.name} data-testid="version-name">
                  {v.name}
                  {v.auto ? (
                    <span className="version-badge" data-testid="version-auto-badge">
                      auto
                    </span>
                  ) : null}
                </div>
              )}
              <div className="version-meta">
                <span title={new Date(v.createdAt).toLocaleString()} data-testid="version-time">
                  {timeAgo(v.createdAt, now)} · {clockTime(v.createdAt, now)}
                </span>{" "}
                · {v.items.length} item
                {v.items.length === 1 ? "" : "s"}
              </div>
              <div className="version-actions">
                <button className="btn btn-secondary btn-sm" data-testid="version-restore" onClick={() => restore(v)} title="Load this version (the current design is saved first)">
                  Restore
                </button>
                <button className="btn btn-quiet btn-sm" data-testid="version-rename" onClick={() => setRenaming({ id: v.id, name: v.name })}>
                  Rename
                </button>
                <button
                  className="btn btn-quiet btn-sm"
                  data-testid="version-duplicate"
                  title="Keep a named copy (auto snapshots are dropped after a while)"
                  onClick={() => {
                    const c = useVersions.getState().duplicateVersion(v.id);
                    if (c) setMessage(`Copied as “${c.name}”.`);
                  }}
                >
                  Duplicate
                </button>
                <button
                  className={`btn btn-sm ${confirmDelete === v.id ? "btn-danger" : "btn-quiet btn-danger-text"}`}
                  data-testid="version-delete"
                  onClick={() => remove(v)}
                >
                  {confirmDelete === v.id ? "Delete?" : "Delete"}
                </button>
              </div>
            </div>
          </li>,
        ])}
        {!versions.length ? (
          <li className="versions-empty muted small">
            No versions yet. Save one to compare layouts (“Option A”, “Option B”). The app also keeps one automatically before big
            changes: a room built from photos, a chat reply with several changes, reset, import or restore.
          </li>
        ) : null}
      </ul>

      <div className="versions-foot">
        <button
          className="btn btn-ghost btn-sm"
          data-testid="versions-export-all"
          title="Download the current design and every version as one file (Import loads it back)"
          onClick={() => download("room-plan-versions.json", exportAllJSON())}
        >
          <Icon.download /> Export all versions
        </button>
        <span className="muted small">Auto snapshots: newest 30 kept</span>
      </div>
    </div>
  );
}
