import { useId, useRef, useState } from "react";
import type { Mount, PlacedItem, Units } from "../shared/types";
import { selectSelectedItem, usePlanner } from "../state/store";
import { Badge, ColorInput, Field, LengthInput, TextInput, formatPrice } from "./controls";
import { Chips, ProductImage, Swatches } from "./ProductBits";
import { formatDims, formatLength } from "../lib/units";
import { Icon } from "./icons";
import { httpUrl } from "../lib/urls";
import { useUI } from "./uiStore";
import { isFlatSurface, surfaceName, surfaceOptions, type Corner, type SurfaceOption } from "../lib/geometry";
import { LightControls } from "./LightControls";
import { isLampLike } from "../lib/lighting";

const RAD = Math.PI / 180;
const CORNERS: { key: Corner; label: string; title: string }[] = [
  { key: "nw", label: "↖ Back left", title: "Back-left (north-west) corner" },
  { key: "ne", label: "Back right ↗", title: "Back-right (north-east) corner" },
  { key: "sw", label: "↙ Front left", title: "Front-left (south-west) corner" },
  { key: "se", label: "Front right ↘", title: "Front-right (south-east) corner" },
];
const ORIGIN_LABEL: Record<PlacedItem["origin"], string> = { existing: "From photos", shape: "Shape", product: "Product" };
/** Things nothing is put on top of from the "Put on…" list (screens, lamps). */
const NOT_A_SUPPORT = /\b(?:monitors?|screens?|displays?|tvs?|televisions?|laptops?|imacs?)\b/i;
/** Floor items lower than this (m) are floor coverings (a rug is the floor, not a surface to put things on). */
const FLAT_COVERING = 0.05;
/** A hanging-lamp name (an older pendant saved as a floor item): the Inspector points at "Hang from ceiling". */
const HANGING_NAME = /\b(?:pendants?|hanging|chandeliers?|ceiling\s+(?:lamps?|lights?))\b/i;

/**
 * "Put on…" choices that make sense: real flat faces (a desk top, a shelf, a cat tower's platform, the floor under a
 * desk) of things big enough for the item, never a lamp, a screen or a rug.
 */
function sensibleOptions(item: PlacedItem, options: SurfaceOption[]): SurfaceOption[] {
  return options.filter(({ support: s, surface }) => {
    if (s.light || isLampLike(s.name) || NOT_A_SUPPORT.test(s.name)) return false;
    if (s.mount === "floor" && !s.supportId && s.dims.h < FLAT_COVERING) return false;
    if (!isFlatSurface(s, surface)) return false;
    return surface.kind === "under" || s.dims.w * s.dims.d >= item.dims.w * item.dims.d - 1e-9;
  });
}

/** Normalize radians to whole degrees in [-180, 180]. */
function toDegrees(rad: number): number {
  let d = Math.round(rad / RAD) % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

export function Inspector() {
  const item = usePlanner(selectSelectedItem);
  const units = usePlanner((s) => s.units);
  if (!item) return null;
  // key: reset local editing state when the selection changes
  return <InspectorBody key={item.id} item={item} units={units} />;
}

function InspectorBody({ item, units }: { item: PlacedItem; units: Units }) {
  const { updateItem, removeItem, duplicateItem, snapItemToWall, snapItemToCornerAt, select, checkpoint } = usePlanner.getState();
  const searchingFor = usePlanner((s) => s.previewTargetId === item.id);
  const ids = { mount: useId(), rot: useId(), corner: useId() };
  const locked = !!item.locked;
  // Wall-mounted items always face out from their wall; the store would undo any other rotation.
  const rotationLocked = locked || item.mount === "wall";
  const sliding = useRef(false);
  const [rotDraft, setRotDraft] = useState<string | null>(null);
  const deg = toDegrees(item.rotationY);

  const patch = (p: Partial<Omit<PlacedItem, "id">>) => updateItem(item.id, p);
  const setDims = (key: "w" | "d" | "h", v: number) => patch({ dims: { ...item.dims, [key]: Math.max(0.01, v) } });
  const setPos = (key: "x" | "y" | "z", v: number) => patch({ position: { ...item.position, [key]: v } });

  const setRotation = (degrees: number, transient = false) => {
    if (!Number.isFinite(degrees)) return;
    updateItem(item.id, { rotationY: Math.max(-180, Math.min(180, degrees)) * RAD }, { transient });
  };

  const commitRotDraft = () => {
    if (rotDraft != null && rotDraft.trim() !== "" && Number(rotDraft) !== deg) setRotation(Number(rotDraft));
    setRotDraft(null);
  };

  const onMount = (mount: Mount) => {
    // Ceiling = the same as "Hang from ceiling": a lamp hangs on a cord (a floor lamp as its shade), not flush upright.
    if (mount === "ceiling" && item.mount !== "ceiling") {
      usePlanner.getState().hangFromCeiling(item.id);
      return;
    }
    // Give wall mounts a sensible eye-level height; the store clamps it to the room.
    const position = mount === "wall" ? { ...item.position, y: Math.max(item.position.y, 1.2) } : item.position;
    patch({ mount, position });
  };

  return (
    <aside className="inspector" data-testid="inspector" aria-label="Inspector">
      <div className="inspector-head">
        <div>
          <div className="eyebrow">{ORIGIN_LABEL[item.origin]}</div>
          <h2 className="inspector-title" title={item.name}>
            {item.name}
          </h2>
        </div>
        <button className="btn btn-icon btn-quiet" data-testid="inspector-close" aria-label="Deselect" title="Close (Esc)" onClick={() => select(null)}>
          <Icon.close />
        </button>
      </div>

      <div className="inspector-scroll">
        {locked ? <div className="inline-msg small">Locked — unlock to move or resize.</div> : null}

        <section className="section">
          <TextInput label="Name" value={item.name} testId="inspector-name" onCommit={(name) => patch({ name })} />
          <Field label="Mount" htmlFor={ids.mount}>
            <select
              id={ids.mount}
              className="input select"
              data-testid="inspector-mount"
              value={item.mount}
              disabled={locked}
              onChange={(e) => onMount(e.target.value as Mount)}
            >
              <option value="floor">Floor</option>
              <option value="wall">Wall</option>
              <option value="ceiling">Ceiling (hanging)</option>
            </select>
          </Field>
          {item.mount === "floor" ? <StackControls item={item} locked={locked} /> : null}
          <HangControls item={item} units={units} locked={locked} />
        </section>

        {/* A lamp's switch, brightness and warmth come first, right under its name (not below the fold). */}
        {item.light ? <LightControls item={item} /> : null}

        <section className="section">
          <h3 className="section-sub">Size</h3>
          <div className="row-3">
            <LengthInput compact label="Width" value={item.dims.w} units={units} disabled={locked} testId="inspector-width" onCommit={(v) => setDims("w", v)} />
            <LengthInput compact label="Depth" value={item.dims.d} units={units} disabled={locked} testId="inspector-depth" onCommit={(v) => setDims("d", v)} />
            <LengthInput compact label="Height" value={item.dims.h} units={units} disabled={locked} testId="inspector-height" onCommit={(v) => setDims("h", v)} />
          </div>
        </section>

        <section className="section">
          <h3 className="section-sub">Position</h3>
          <div className={item.mount === "wall" ? "row-3" : "row-2"}>
            <LengthInput compact signed label="X (left/right)" value={item.position.x} units={units} disabled={locked} testId="inspector-x" onCommit={(v) => setPos("x", v)} />
            <LengthInput compact signed label="Z (back/front)" value={item.position.z} units={units} disabled={locked} testId="inspector-z" onCommit={(v) => setPos("z", v)} />
            {item.mount === "wall" ? (
              <LengthInput compact label="Elevation" min={0} value={item.position.y} units={units} disabled={locked} testId="inspector-y" onCommit={(v) => setPos("y", v)} />
            ) : null}
          </div>
          <p className="muted small">Measured from the room's center.</p>

          <div className="field">
            <label className="field-label" htmlFor={ids.rot}>
              Rotation
            </label>
            <div className="rotation-row">
              <input
                id={ids.rot}
                type="range"
                className="range"
                min={-180}
                max={180}
                step={1}
                value={deg}
                disabled={rotationLocked}
                data-testid="inspector-rotation"
                onPointerDown={() => {
                  sliding.current = true;
                  checkpoint();
                }}
                onPointerUp={() => (sliding.current = false)}
                onChange={(e) => setRotation(Number(e.target.value), sliding.current)}
              />
              <div className="input-suffix">
                <input
                  className="input input-num"
                  type="number"
                  min={-180}
                  max={180}
                  aria-label="Rotation in degrees"
                  data-testid="inspector-rotation-number"
                  disabled={rotationLocked}
                  value={rotDraft ?? String(deg)}
                  onChange={(e) => setRotDraft(e.target.value)}
                  onBlur={commitRotDraft}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.currentTarget.blur();
                  }}
                />
                <span aria-hidden="true">°</span>
              </div>
            </div>
            {item.mount === "wall" ? <div className="field-hint">Wall items face out from their wall.</div> : null}
          </div>
        </section>

        <section className="section">
          <ColorInput
            label="Color"
            value={item.color}
            testId="inspector-color"
            onChange={(color, first) => updateItem(item.id, { color }, { transient: !first })}
          />
        </section>

        <section className="section">
          <button
            className={`btn btn-block find-for-btn ${searchingFor ? "btn-accent-soft" : "btn-primary"}`}
            data-testid="find-for-btn"
            title="Search for real products to put in this spot"
            onClick={() => useUI.getState().findProductsFor(item)}
          >
            <Icon.search /> {item.origin === "product" ? "Find alternatives for this spot" : "Find real products for this"}
          </button>
          {item.mount !== "wall" ? (
            <div className="field">
              <span className="field-label" id={ids.corner}>
                Move to corner
              </span>
              {/* Laid out like the floor plan from the top view: back (north) wall at the top. */}
              <div className="corner-picker" role="group" aria-labelledby={ids.corner}>
                {CORNERS.map((c) => (
                  <button
                    key={c.key}
                    className="btn btn-secondary"
                    data-testid={`corner-${c.key}-btn`}
                    title={c.title}
                    disabled={locked}
                    onClick={() => snapItemToCornerAt(item.id, c.key)}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          <div className="btn-grid">
            <button className="btn btn-secondary" data-testid="snap-wall-btn" disabled={locked} onClick={() => snapItemToWall(item.id)}>
              Snap to wall
            </button>
            <button className="btn btn-secondary" data-testid="duplicate-btn" onClick={() => duplicateItem(item.id)}>
              Duplicate
            </button>
            <button
              className={`btn ${locked ? "btn-accent-soft" : "btn-secondary"}`}
              data-testid="lock-btn"
              aria-pressed={locked}
              onClick={() => patch({ locked: !locked })}
            >
              {locked ? <Icon.lock /> : <Icon.unlock />} {locked ? "Locked" : "Lock"}
            </button>
          </div>
          <button className="btn btn-danger btn-block" data-testid="delete-btn" onClick={() => removeItem(item.id)}>
            Delete item
          </button>
        </section>

        {/* Anything else can be made a light source, at the bottom (rarely needed). */}
        {!item.light ? <LightControls item={item} /> : null}

        {item.product ? <ProductSection item={item} units={units} /> : null}
      </div>
    </aside>
  );
}

/**
 * "On top of: Desk" (or "Under", "On the middle level of") + "Put on floor" for a stacked item; otherwise a "Put on…"
 * picker of every surface the item fits on: "On top of Desk", "Cat tower — middle level", "Under Desk".
 */
function StackControls({ item, locked }: { item: PlacedItem; locked: boolean }) {
  const items = usePlanner((s) => s.items);
  const units = usePlanner((s) => s.units);
  const id = useId();
  const { placeOnTop } = usePlanner.getState();
  const support = item.supportId ? items.find((it) => it.id === item.supportId) : undefined;
  if (support) {
    const y = item.supportSurfaceY;
    let where = "On top of";
    if (y !== undefined && y < 0.01) where = "Under";
    else if (y !== undefined) {
      const name = surfaceName(support, y);
      where = name === "top" ? "On top of" : `On the ${name} of`;
    }
    return (
      <div className="field stack-row" data-testid="inspector-stack">
        <span className="field-label" data-testid="inspector-stack-where">
          {where}
        </span>
        <div className="stack-on" style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "space-between" }}>
          <button className="btn btn-quiet stack-support" style={{ fontWeight: 600, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }} data-testid="inspector-support" title="Select it" onClick={() => usePlanner.getState().select(support.id)}>
            {support.name}
          </button>
          <button className="btn btn-secondary btn-sm" data-testid="put-on-floor-btn" disabled={locked} onClick={() => placeOnTop(item.id, null)}>
            {where === "Under" ? "Take out" : "Put on floor"}
          </button>
        </div>
      </div>
    );
  }
  const options = sensibleOptions(item, surfaceOptions(item, items));
  if (!options.length) return null;
  const perSupport = new Map<string, number>();
  for (const o of options) if (o.surface.kind !== "under") perSupport.set(o.support.id, (perSupport.get(o.support.id) ?? 0) + 1);
  // The top keeps the support's id as its value (one choice per support, as before); other surfaces add their height.
  const valueOf = (o: SurfaceOption) => (o.surface.kind === "top" ? o.support.id : `${o.support.id}@${o.surface.y}`);
  const labelOf = (o: SurfaceOption) => {
    if (o.surface.kind === "under") return `Under ${o.support.name}`;
    if ((perSupport.get(o.support.id) ?? 0) < 2) return `On top of ${o.support.name}`;
    return `${o.support.name} — ${o.name}${o.surface.kind === "top" ? "" : ` (${formatLength(o.surface.y, units)})`}`;
  };
  return (
    <Field label="Put on…" htmlFor={id}>
      <select
        id={id}
        className="input select"
        data-testid="put-on-select"
        value=""
        disabled={locked}
        onChange={(e) => {
          const v = e.target.value;
          if (!v) return;
          const at = v.lastIndexOf("@");
          if (at < 0) placeOnTop(item.id, v);
          else placeOnTop(item.id, v.slice(0, at), Number(v.slice(at + 1)));
        }}
      >
        <option value="">On the floor</option>
        {options.map((o) => (
          <option key={valueOf(o)} value={valueOf(o)}>
            {labelOf(o)}
          </option>
        ))}
      </select>
    </Field>
  );
}

/**
 * Ceiling items: how far they hang down (ceiling to their bottom; the cord stretches). Anything else: a "Hang from
 * ceiling" button (a lamp gets a pendant's drop, other things hang flush; see hangFromCeiling).
 */
function HangControls({ item, units, locked }: { item: PlacedItem; units: Units; locked: boolean }) {
  const roomHeight = usePlanner((s) => s.room.height);
  const [dropKey, setDropKey] = useState(0);
  const { hangFromCeiling } = usePlanner.getState();
  if (item.mount === "ceiling") {
    const drop = Math.max(0, roomHeight - item.position.y);
    return (
      <div className="field" data-testid="inspector-hang">
        <LengthInput
          // A new key after each commit: the field shows the drop actually used (clamped between the item's own body and
          // 30 cm above the floor), also when that is the value it already showed.
          key={dropKey}
          label="Drop (ceiling to bottom)"
          value={drop}
          units={units}
          min={0}
          disabled={locked}
          testId="inspector-drop"
          onCommit={(v) => {
            hangFromCeiling(item.id, v);
            setDropKey((k) => k + 1);
          }}
        />
        <div className="field-hint">How far it hangs down (its cord gets longer or shorter), from its own height to 1 ft off the floor.</div>
      </div>
    );
  }
  const looksHanging = HANGING_NAME.test(item.name) || (!!item.product && HANGING_NAME.test(`${item.product.name} ${item.product.summary ?? ""}`));
  return (
    <>
      {looksHanging ? (
        <div className="inline-msg small hang-hint" data-testid="hang-hint">
          This looks like a hanging lamp: <strong>Hang from ceiling</strong> puts it back up with its cord.
        </div>
      ) : null}
      <button
        className={`btn ${looksHanging ? "btn-primary" : "btn-secondary"} btn-block`}
        data-testid="hang-btn"
        disabled={locked}
        title="Hang it from the ceiling"
        onClick={() => hangFromCeiling(item.id)}
      >
        Hang from ceiling
      </button>
    </>
  );
}

function ProductSection({ item, units }: { item: PlacedItem; units: Units }) {
  const p = item.product!;
  const price = formatPrice(p.price, p.currency);
  return (
    <section className="section product-section" data-testid="inspector-product">
      <h3 className="section-sub">Product</h3>
      <ProductImage src={httpUrl(p.imageUrl)} alt={p.name} />
      <dl className="kv">
        <dt>Retailer</dt>
        <dd>{p.retailer}</dd>
        {price ? (
          <>
            <dt>Price</dt>
            <dd className="price">{price}</dd>
          </>
        ) : null}
        <dt>Size</dt>
        <dd>
          {p.dimsText || formatDims(p.dims, units)}{" "}
          {p.dimsSource === "estimated" ? (
            <span title="Dimensions estimated by AI">
              <Badge tone="warn">est.</Badge>
            </span>
          ) : (
            <Badge>listed</Badge>
          )}
        </dd>
        {p.origin ? (
          <>
            <dt>Origin</dt>
            <dd>{p.origin}</dd>
          </>
        ) : null}
        {p.materials.length ? (
          <>
            <dt>Materials</dt>
            <dd>{p.materials.join(", ")}</dd>
          </>
        ) : null}
      </dl>
      <Swatches colors={p.colors} />
      <Chips items={p.style} label="Style" />
      {p.summary ? <p className="small summary">{p.summary}</p> : null}
      {httpUrl(p.url) ? (
        <a className="btn btn-secondary btn-block" href={httpUrl(p.url)} target="_blank" rel="noopener noreferrer" data-testid="inspector-product-link">
          View product ↗
        </a>
      ) : null}
    </section>
  );
}
