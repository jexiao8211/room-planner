import type { PlacedItem } from "../shared/types";
import { usePlanner } from "../state/store";
import { SHAPE_PRESETS } from "../lib/presets";
import { formatDims } from "../lib/units";
import { stackOrder } from "../lib/geometry";
import { Icon, ShapeIcon } from "./icons";

const GROUPS: { origin: PlacedItem["origin"]; title: string; empty: string }[] = [
  { origin: "existing", title: "Existing", empty: "Furniture detected from your photos shows up here." },
  { origin: "shape", title: "Added", empty: "Shapes you add show up here." },
  { origin: "product", title: "Products", empty: "Products from Find online show up here." },
];

export function AddTab() {
  const addItem = usePlanner((s) => s.addItem);
  return (
    <div className="tab-body">
      <section className="section" aria-labelledby="shapes-h">
        <div className="section-head">
          <h2 id="shapes-h">Add a shape</h2>
        </div>
        <div className="preset-grid">
          {SHAPE_PRESETS.map((p) => (
            <button
              key={p.key}
              className="preset-btn"
              data-testid={`preset-${p.key}`}
              style={{ ["--shape-fill" as string]: `${p.color}55` }}
              onClick={() => addItem({ name: p.label, dims: p.dims, mount: p.mount, color: p.color, parts: p.parts, origin: "shape" })}
            >
              <span className="preset-icon" style={{ color: shade(p.color) }}>
                <ShapeIcon kind={p.key} />
              </span>
              <span className="preset-label">{p.label}</span>
              {p.mount !== "floor" ? <span className="preset-mount">{p.mount}</span> : null}
            </button>
          ))}
        </div>
      </section>
      <ItemList />
    </div>
  );
}

function ItemList() {
  const items = usePlanner((s) => s.items);
  const selectedId = usePlanner((s) => s.selectedId);
  const units = usePlanner((s) => s.units);
  const { select, updateItem, removeItem } = usePlanner.getState();

  return (
    <section className="section" aria-labelledby="items-h">
      <div className="section-head">
        <h2 id="items-h">Items in room</h2>
        <span className="muted small">{items.length}</span>
      </div>
      {GROUPS.map((g) => {
        // Stacked items are listed (indented) right under their support when it is in the same group.
        const list = stackOrder(items.filter((it) => it.origin === g.origin));
        return (
          <div key={g.origin} className="item-group" data-testid={`item-group-${g.origin}`}>
            <h3 className="group-title">
              {g.title} <span className="count">{list.length}</span>
            </h3>
            {list.length === 0 ? (
              <p className="muted small empty">{g.empty}</p>
            ) : (
              <ul className="item-list">
                {list.map(({ item: it, depth }) => (
                  <li
                    key={it.id}
                    className={`item-row${it.id === selectedId ? " selected" : ""}${it.hidden ? " is-hidden" : ""}`}
                    data-testid={`item-row-${it.id}`}
                    data-depth={depth}
                    style={depth ? { marginLeft: Math.min(depth, 4) * 16 } : undefined}
                  >
                    <button className="item-main" onClick={() => select(it.id)} aria-pressed={it.id === selectedId} title="Select">
                      <span className="swatch" style={{ background: it.color }} />
                      <span className="item-text">
                        <span className="item-name">
                          {it.name}
                          {it.locked ? (
                            <span className="lock-mark" title="Locked">
                              <Icon.lock />
                            </span>
                          ) : null}
                        </span>
                        <span className="item-dims">
                          {formatDims(it.dims, units)}
                          {it.supportId ? <span data-testid={`item-on-${it.id}`}> · {it.supportSurfaceY === 0 ? "under" : "on"} {items.find((o) => o.id === it.supportId)?.name ?? "?"}</span> : null}
                        </span>
                      </span>
                    </button>
                    <button
                      className="btn btn-icon btn-sm btn-quiet"
                      data-testid={`item-hide-${it.id}`}
                      aria-label={it.hidden ? `Show ${it.name}` : `Hide ${it.name}`}
                      title={it.hidden ? "Show" : "Hide"}
                      onClick={() => updateItem(it.id, { hidden: !it.hidden })}
                    >
                      {it.hidden ? <Icon.eyeOff /> : <Icon.eye />}
                    </button>
                    <button
                      className="btn btn-icon btn-sm btn-quiet btn-danger-text"
                      data-testid={`item-delete-${it.id}`}
                      aria-label={`Delete ${it.name}`}
                      title="Delete"
                      onClick={() => removeItem(it.id)}
                    >
                      <Icon.close />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </section>
  );
}

/** Darken a hex color for icon strokes. */
function shade(hex: string, f = 0.6): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return "currentColor";
  const n = parseInt(m[1], 16);
  const c = (v: number) => Math.round(v * f).toString(16).padStart(2, "0");
  return `#${c((n >> 16) & 255)}${c((n >> 8) & 255)}${c(n & 255)}`;
}
