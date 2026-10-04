import { useId, useRef, useState } from "react";
import type { Opening, Room, WallSide } from "../shared/types";
import { usePlanner } from "../state/store";
import { formatLength, parseLength } from "../lib/units";
import { newId } from "../lib/presets";
import { DEFAULT_KNOWN_LABEL, KNOWN_LABEL_PRESETS, MAX_PHOTOS, useUI } from "./uiStore";
import { ColorInput, Field, LengthInput, Spinner, TextInput, useNow } from "./controls";
import { Icon } from "./icons";
import { windowCovering } from "../lib/lighting";
import { setWindowCovering } from "../state/lightingActions";

const WALLS: { key: WallSide; label: string }[] = [
  { key: "north", label: "Back (north)" },
  { key: "south", label: "Front (south)" },
  { key: "west", label: "Left (west)" },
  { key: "east", label: "Right (east)" },
];

function wallLength(room: Room, wall: WallSide) {
  return wall === "north" || wall === "south" ? room.width : room.depth;
}

export function RoomTab() {
  return (
    <div className="tab-body">
      <PhotoSection />
      <RoomSizeSection />
      <OpeningsSection />
    </div>
  );
}

function PhotoSection() {
  const units = usePlanner((s) => s.units);
  const photos = useUI((s) => s.photos);
  const knownLabel = useUI((s) => s.knownLabel);
  const knownLength = useUI((s) => s.knownLength);
  const photoNotes = useUI((s) => s.photoNotes);
  const build = useUI((s) => s.build);
  const buildNotes = useUI((s) => s.buildNotes);
  const buildMock = useUI((s) => s.buildMock);
  const { addPhotos, removePhoto, setRoomForm, startBuild, cancelBuild } = useUI.getState();
  const [dragOver, setDragOver] = useState(false);
  const [photoMsg, setPhotoMsg] = useState<string | null>(null);
  /** Number of added items a rebuild would replace, while the user is being asked to confirm. */
  const [confirmReplace, setConfirmReplace] = useState<number | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const ids = { photo: useId(), label: useId(), labelList: useId(), length: useId(), notes: useId() };

  const running = build.status === "running";
  const now = useNow(running);
  const elapsed = build.startedAt ? Math.max(0, Math.floor((now - build.startedAt) / 1000)) : 0;

  const knownMeters = knownLength.trim() ? parseLength(knownLength, units) : null;
  const knownInvalid = knownLength.trim() !== "" && knownMeters == null;

  const onFiles = (list: FileList | null) => {
    if (!list) return;
    setPhotoMsg(addPhotos(Array.from(list)));
    if (fileRef.current) fileRef.current.value = "";
  };

  // Asks in-page rather than with confirm(): native dialogs can be blocked (embedded browsers), which
  // silently returns false and made the button look dead.
  const onBuild = (confirmed = false) => {
    if (knownInvalid) return;
    const added = usePlanner.getState().items.filter((it) => it.origin !== "existing").length;
    if (added > 0 && !confirmed) {
      setConfirmReplace(added);
      return;
    }
    setConfirmReplace(null);
    void startBuild(knownMeters);
  };

  return (
    <section className="section" aria-labelledby="photos-h">
      <div className="section-head">
        <h2 id="photos-h">Room from photos</h2>
        <span className="muted small">
          {photos.length}/{MAX_PHOTOS}
        </span>
      </div>
      <p className="muted small">Add 1–3 photos from different corners. Claude estimates the size, doors, windows and furniture.</p>

      <label
        htmlFor={ids.photo}
        className={`dropzone${dragOver ? " dragover" : ""}${photos.length >= MAX_PHOTOS ? " full" : ""}`}
        data-testid="photo-dropzone"
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          onFiles(e.dataTransfer.files);
        }}
      >
        <Icon.photo />
        <span className="dz-title">{photos.length >= MAX_PHOTOS ? "3 photos added" : "Drop photos here"}</span>
        <span className="dz-sub">or click to choose · JPG, PNG, WebP</span>
        <input
          id={ids.photo}
          ref={fileRef}
          className="visually-hidden"
          type="file"
          accept="image/*"
          multiple
          data-testid="photo-input"
          disabled={photos.length >= MAX_PHOTOS || running}
          onChange={(e) => onFiles(e.target.files)}
        />
      </label>
      {photoMsg ? <div className="inline-msg warn small">{photoMsg}</div> : null}

      {photos.length > 0 ? (
        <ul className="thumbs" aria-label="Selected photos">
          {photos.map((p, i) => (
            <li key={p.id} className="thumb" data-testid="photo-thumb">
              <img src={p.url} alt={`Photo ${i + 1}: ${p.file.name}`} />
              <button
                className="thumb-remove"
                data-testid={`photo-remove-${i}`}
                aria-label={`Remove photo ${i + 1}`}
                title="Remove"
                disabled={running}
                onClick={() => {
                  removePhoto(p.id);
                  setPhotoMsg(null);
                }}
              >
                <Icon.close />
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <fieldset className="subgroup">
        <legend>One thing I know the size of (optional)</legend>
        <div className="row-2">
          <Field
            label="What"
            htmlFor={ids.label}
            hint={
              knownLabel.trim() ? null : (
                <span data-testid="known-label-assumed">{knownLength.trim() ? `(assumed ${DEFAULT_KNOWN_LABEL})` : `blank = ${DEFAULT_KNOWN_LABEL}`}</span>
              )
            }
          >
            <input
              id={ids.label}
              className="input"
              data-testid="known-label"
              list={ids.labelList}
              placeholder={DEFAULT_KNOWN_LABEL}
              value={knownLabel}
              onChange={(e) => setRoomForm({ knownLabel: e.target.value })}
            />
            <datalist id={ids.labelList}>
              {KNOWN_LABEL_PRESETS.map((p) => (
                <option key={p} value={p} />
              ))}
            </datalist>
          </Field>
          <Field
            label="Length"
            htmlFor={ids.length}
            hint={
              knownLength.trim() ? (
                <span data-testid="known-parsed" className={knownInvalid ? "field-error" : "ok-text"}>
                  {knownInvalid ? "can't parse" : `= ${formatLength(knownMeters!, "imperial")} · ${formatLength(knownMeters!, "metric")}`}
                </span>
              ) : (
                <span>e.g. 8' or 2.4 m</span>
              )
            }
          >
            <input
              id={ids.length}
              className={`input${knownInvalid ? " input-invalid" : ""}`}
              data-testid="known-length"
              placeholder={units === "imperial" ? `8' 0"` : "2.44 m"}
              value={knownLength}
              onChange={(e) => setRoomForm({ knownLength: e.target.value })}
            />
          </Field>
        </div>
      </fieldset>

      <Field label="Notes for Claude (optional)" htmlFor={ids.notes}>
        <textarea
          id={ids.notes}
          className="input textarea"
          data-testid="photo-notes"
          rows={2}
          placeholder="e.g. the bed is a king; the closet is on the left wall"
          value={photoNotes}
          onChange={(e) => setRoomForm({ photoNotes: e.target.value })}
        />
      </Field>

      {running ? (
        <div className="progress-card" data-testid="build-progress" role="status">
          <Spinner />
          <div className="progress-text">
            <strong>Analyzing photos… {elapsed}s</strong>
            <span className="muted small">This usually takes 30–90 seconds.</span>
          </div>
          <button className="btn btn-secondary btn-sm" data-testid="build-cancel-btn" onClick={cancelBuild}>
            Cancel
          </button>
        </div>
      ) : (
        <>
          <button
            className="btn btn-primary btn-block"
            data-testid="build-room-btn"
            disabled={photos.length === 0 || knownInvalid}
            title={knownInvalid ? "Fix or clear the known length first" : undefined}
            onClick={() => onBuild()}
          >
            Build room from photos
          </button>
          {confirmReplace != null ? (
            <div className="inline-msg warn small" data-testid="build-confirm" role="alert">
              This replaces the current room and its {confirmReplace} added item{confirmReplace === 1 ? "" : "s"} (you can undo).
              <div className="confirm-actions">
                <button className="btn btn-primary btn-sm" data-testid="build-confirm-btn" onClick={() => onBuild(true)}>
                  Replace room
                </button>
                <button className="btn btn-secondary btn-sm" data-testid="build-confirm-cancel" onClick={() => setConfirmReplace(null)}>
                  Keep current
                </button>
              </div>
            </div>
          ) : null}
          {knownInvalid && photos.length > 0 ? (
            <div className="inline-msg warn small" data-testid="known-invalid-msg">
              The known length can't be read — fix it (e.g. 8' or 2.4 m) or clear it to build without it.
            </div>
          ) : null}
        </>
      )}

      {build.status === "error" ? (
        <div className="inline-msg error" data-testid="build-error" role="alert">
          {build.error}
          {build.resend && photos.length > 0 ? (
            <>
              {" "}
              <button type="button" className="btn btn-secondary btn-sm" data-testid="build-resend" onClick={() => onBuild(true)}>
                Resend
              </button>
            </>
          ) : null}
        </div>
      ) : null}
      {build.status === "cancelled" ? <div className="inline-msg small muted">Cancelled.</div> : null}
      {build.status === "done" ? (
        <div className="inline-msg success" data-testid="build-notes">
          <strong>Room built{buildMock ? " (demo data)" : ""}.</strong> {buildNotes ?? "Adjust anything below."}
        </div>
      ) : null}
    </section>
  );
}

function RoomSizeSection() {
  const room = usePlanner((s) => s.room);
  const units = usePlanner((s) => s.units);
  const updateRoom = usePlanner((s) => s.updateRoom);

  /** First change of a color-picking session records undo; later ticks update in place. */
  const setColor = (key: "wallColor" | "floorColor", hex: string, first: boolean) => {
    if (first) updateRoom({ [key]: hex });
    else usePlanner.setState((s) => ({ room: { ...s.room, [key]: hex } }));
  };

  return (
    <section className="section" aria-labelledby="size-h">
      <div className="section-head">
        <h2 id="size-h">Room size</h2>
        <span className="muted small">
          {formatLength(room.width, units)} × {formatLength(room.depth, units)}
        </span>
      </div>
      <TextInput label="Name" value={room.name} testId="room-name" onCommit={(name) => updateRoom({ name })} />
      <div className="row-3">
        <LengthInput label="Width" value={room.width} units={units} testId="room-width" min={1} onCommit={(width) => updateRoom({ width })} />
        <LengthInput label="Depth" value={room.depth} units={units} testId="room-depth" min={1} onCommit={(depth) => updateRoom({ depth })} />
        <LengthInput label="Height" value={room.height} units={units} testId="room-height" min={1} onCommit={(height) => updateRoom({ height })} />
      </div>
      <div className="row-2">
        <ColorInput label="Walls" value={room.wallColor} testId="room-wall-color" onChange={(hex, first) => setColor("wallColor", hex, first)} />
        <ColorInput label="Floor" value={room.floorColor} testId="room-floor-color" onChange={(hex, first) => setColor("floorColor", hex, first)} />
      </div>
    </section>
  );
}

function OpeningsSection() {
  const room = usePlanner((s) => s.room);
  const units = usePlanner((s) => s.units);
  const updateRoom = usePlanner((s) => s.updateRoom);

  const patchOpening = (id: string, patch: Partial<Opening>) =>
    updateRoom({ openings: room.openings.map((o) => (o.id === id ? clampOpening({ ...o, ...patch }, room) : o)) });

  const add = (kind: Opening["kind"]) => {
    const wall: WallSide = kind === "door" ? "south" : "north";
    const o: Opening =
      kind === "door"
        ? { id: newId("door"), kind, wall, offset: wallLength(room, wall) / 2, width: 0.81, height: 2.03, sill: 0 }
        : { id: newId("win"), kind, wall, offset: wallLength(room, wall) / 2, width: 1.0, height: 1.2, sill: 0.9 };
    updateRoom({ openings: [...room.openings, clampOpening(o, room)] });
  };

  return (
    <section className="section" aria-labelledby="open-h">
      <div className="section-head">
        <h2 id="open-h">Doors &amp; windows</h2>
        <span className="muted small">{room.openings.length}</span>
      </div>
      {room.openings.length === 0 ? <p className="muted small">No openings yet.</p> : null}
      <ul className="openings">
        {room.openings.map((o, i) => (
          <li key={o.id} className="opening-card" data-testid={`opening-${o.id}`}>
            <div className="opening-head">
              <select
                className="input select select-sm"
                aria-label={`Opening ${i + 1} kind`}
                data-testid={`opening-kind-${o.id}`}
                value={o.kind}
                onChange={(e) => {
                  const kind = e.target.value as Opening["kind"];
                  patchOpening(o.id, { kind, sill: kind === "door" ? 0 : o.sill || 0.9 });
                }}
              >
                <option value="door">Door</option>
                <option value="window">Window</option>
              </select>
              <select
                className="input select select-sm"
                aria-label={`Opening ${i + 1} wall`}
                data-testid={`opening-wall-${o.id}`}
                value={o.wall}
                onChange={(e) => {
                  const wall = e.target.value as WallSide;
                  patchOpening(o.id, { wall, offset: Math.min(o.offset, wallLength(room, wall) - o.width / 2) });
                }}
              >
                {WALLS.map((w) => (
                  <option key={w.key} value={w.key}>
                    {w.label}
                  </option>
                ))}
              </select>
              <button
                className="btn btn-icon btn-sm btn-quiet"
                data-testid={`opening-remove-${o.id}`}
                aria-label={`Remove ${o.kind} ${i + 1}`}
                title="Remove"
                onClick={() => updateRoom({ openings: room.openings.filter((x) => x.id !== o.id) })}
              >
                <Icon.close />
              </button>
            </div>
            <div className="row-4">
              <LengthInput compact label="Offset" value={o.offset} units={units} min={0} onCommit={(offset) => patchOpening(o.id, { offset })} testId={`opening-offset-${o.id}`} />
              <LengthInput compact label="Width" value={o.width} units={units} onCommit={(width) => patchOpening(o.id, { width })} testId={`opening-width-${o.id}`} />
              <LengthInput compact label="Height" value={o.height} units={units} onCommit={(height) => patchOpening(o.id, { height })} testId={`opening-height-${o.id}`} />
              <LengthInput
                compact
                label="Sill"
                value={o.sill}
                units={units}
                min={0}
                disabled={o.kind === "door"}
                onCommit={(sill) => patchOpening(o.id, { sill })}
                testId={`opening-sill-${o.id}`}
              />
            </div>
            {o.kind === "window" ? (
              <div className="opening-blinds">
                <span className="field-label">Blinds</span>
                <div className="segmented" role="group" aria-label={`Window ${i + 1} blinds`}>
                  {(["open", "closed"] as const).map((c) => (
                    <button
                      key={c}
                      className={`seg-btn${windowCovering(o) === c ? " active" : ""}`}
                      aria-pressed={windowCovering(o) === c}
                      data-testid={`opening-covering-${c}-${o.id}`}
                      onClick={() => setWindowCovering(o.id, c)}
                    >
                      {c === "open" ? "Open" : "Closed"}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      <div className="row-2">
        <button className="btn btn-secondary" data-testid="add-door-btn" onClick={() => add("door")}>
          <Icon.plus /> Add door
        </button>
        <button className="btn btn-secondary" data-testid="add-window-btn" onClick={() => add("window")}>
          <Icon.plus /> Add window
        </button>
      </div>
      <p className="muted small">Offset runs from the wall's west end (back/front walls) or north end (side walls) to the opening's center.</p>
    </section>
  );
}

/** Keep an opening inside its wall (width/offset) and below the ceiling (height/sill). */
function clampOpening(o: Opening, room: Room): Opening {
  const len = wallLength(room, o.wall);
  const width = Math.min(Math.max(0.2, o.width), len);
  const offset = Math.min(Math.max(width / 2, o.offset), len - width / 2);
  const sill = o.kind === "door" ? 0 : Math.min(Math.max(0, o.sill), room.height - 0.1);
  const height = Math.min(Math.max(0.2, o.height), room.height - sill);
  return { ...o, width, offset, sill, height };
}
