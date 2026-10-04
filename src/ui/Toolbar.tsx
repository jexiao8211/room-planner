import { useEffect, useRef, useState } from "react";
import { usePlanner } from "../state/store";
import { setCameraPreset, type CameraPreset } from "../scene";
import { Icon } from "./icons";
import { importPlanOrVersions, useVersions } from "../state/versions";
import { VersionsButton } from "./VersionsPanel";
import { LightingControl } from "./LightingControl";

const CAMERA_PRESETS: { key: CameraPreset; label: string; title: string }[] = [
  { key: "iso", label: "Iso", title: "Corner view" },
  { key: "top", label: "Top", title: "Top-down plan view" },
  { key: "eye", label: "Eye", title: "Eye level from the door" },
];

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

export function Toolbar() {
  const canUndo = usePlanner((s) => s.past.length > 0);
  const canRedo = usePlanner((s) => s.future.length > 0);
  const undo = usePlanner((s) => s.undo);
  const redo = usePlanner((s) => s.redo);
  const units = usePlanner((s) => s.units);
  const setUnits = usePlanner((s) => s.setUnits);
  const roomName = usePlanner((s) => s.room.name);
  const importRef = useRef<HTMLInputElement>(null);
  // In-page confirm/error instead of confirm()/alert(), which embedded browsers may block.
  const [confirmReset, setConfirmReset] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  useEffect(() => {
    if (!confirmReset) return;
    const t = setTimeout(() => setConfirmReset(false), 5000);
    return () => clearTimeout(t);
  }, [confirmReset]);
  useEffect(() => {
    if (!importError) return;
    const t = setTimeout(() => setImportError(null), 8000);
    return () => clearTimeout(t);
  }, [importError]);

  const onImport = async (file: File | undefined) => {
    if (!file) return;
    try {
      const text = await file.text();
      // A plan file or an "all versions" export; the current design is kept as an auto version first.
      importPlanOrVersions(text);
      usePlanner.getState().setPreview(null);
      setCameraPreset("iso");
    } catch (e) {
      setImportError(`Couldn't import "${file.name}": ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      if (importRef.current) importRef.current.value = "";
    }
  };

  const onReset = () => {
    if (!confirmReset) {
      setConfirmReset(true);
      return;
    }
    setConfirmReset(false);
    useVersions.getState().autoSnapshot("reset");
    usePlanner.getState().resetAll();
    setCameraPreset("iso");
  };

  return (
    <header className="toolbar" role="toolbar" aria-label="Main toolbar">
      <div className="brand">
        <Icon.logo />
        <div className="brand-text">
          <span className="brand-name">Room Planner</span>
          <span className="brand-room" title={roomName}>
            {roomName}
          </span>
        </div>
      </div>

      <div className="tb-group" aria-label="History">
        <button className="btn btn-icon" data-testid="undo-btn" onClick={undo} disabled={!canUndo} title="Undo (Ctrl+Z)" aria-label="Undo">
          <Icon.undo />
        </button>
        <button className="btn btn-icon" data-testid="redo-btn" onClick={redo} disabled={!canRedo} title="Redo (Ctrl+Shift+Z)" aria-label="Redo">
          <Icon.redo />
        </button>
      </div>

      <div className="tb-group" role="group" aria-label="Camera">
        <span className="tb-label">View</span>
        <div className="segmented">
          {CAMERA_PRESETS.map((p) => (
            <button key={p.key} className="seg-btn" data-testid={`camera-${p.key}`} title={p.title} onClick={() => setCameraPreset(p.key)}>
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <LightingControl />

      <div className="tb-spacer" />

      <div className="tb-group">
        <span className="tb-label" id="units-label">
          Units
        </span>
        <button
          className="segmented units-toggle"
          data-testid="units-toggle"
          aria-labelledby="units-label"
          aria-pressed={units === "metric"}
          title="Switch between feet/inches and meters"
          onClick={() => setUnits(units === "imperial" ? "metric" : "imperial")}
        >
          <span className={`seg-btn${units === "imperial" ? " active" : ""}`}>ft/in</span>
          <span className={`seg-btn${units === "metric" ? " active" : ""}`}>m</span>
        </button>
      </div>

      <div className="tb-group">
        <VersionsButton />
        {/* Export / Import / Reset turn icon-only on narrower windows (styles.css .tb-btn-label), before Versions does. */}
        <button
          className="btn btn-ghost"
          data-testid="export-btn"
          aria-label="Export"
          title="Export this plan as room-plan.json"
          onClick={() => download("room-plan.json", usePlanner.getState().exportJSON())}
        >
          <Icon.download /> <span className="tb-btn-label">Export</span>
        </button>
        <label className="btn btn-ghost" title="Import a room-plan.json file" aria-label="Import">
          <Icon.upload /> <span className="tb-btn-label">Import</span>
          <input
            ref={importRef}
            className="visually-hidden"
            type="file"
            accept=".json,application/json"
            data-testid="import-input"
            onChange={(e) => onImport(e.target.files?.[0])}
          />
        </label>
        <button
          className={confirmReset ? "btn btn-danger" : "btn btn-ghost btn-danger-text"}
          data-testid="reset-btn"
          onClick={onReset}
          title={confirmReset ? "Removes every item and restores the default room (you can undo)" : "Start over with the default room"}
          aria-label={confirmReset ? "Click again to reset" : "Reset"}
        >
          <Icon.reset /> {confirmReset ? <span className="tb-confirm-label">
              <span className="tb-confirm-long">Click again to reset</span>
              <span className="tb-confirm-short">Sure?</span>
            </span> : <span className="tb-btn-label tb-reset-label">Reset</span>}
        </button>
        {importError ? (
          <div className="toolbar-error" role="alert" data-testid="import-error" onClick={() => setImportError(null)}>
            {importError}
          </div>
        ) : null}
      </div>
    </header>
  );
}
