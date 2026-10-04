import { useId } from "react";
import type { Mount, PlacedItem, ProductCandidate, Units } from "../shared/types";
import { usePlanner } from "../state/store";
import { useUI } from "./uiStore";
import { Badge, Field, Spinner, formatPrice, useNow } from "./controls";
import { Chips, DimsLine, ProductImage, Swatches } from "./ProductBits";
import { formatDims } from "../lib/units";
import { fitNotes } from "./fitNotes";
import { Icon } from "./icons";
import { httpUrl } from "../lib/urls";

const STYLE_SUGGESTIONS = ["Japanese", "Mid-century modern", "Scandinavian", "Industrial", "Bohemian", "Minimalist"];
const MOUNT_LABEL: Record<Mount, string> = { floor: "Floor", wall: "Wall", ceiling: "Ceiling" };

export function FindTab() {
  const form = useUI((s) => s.form);
  const search = useUI((s) => s.search);
  const results = useUI((s) => s.results);
  const notes = useUI((s) => s.resultsNotes);
  const mock = useUI((s) => s.resultsMock);
  const hasSearched = useUI((s) => s.hasSearched);
  const inferred = useUI((s) => s.inferred);
  const target = usePlanner((s) => s.items.find((it) => it.id === s.previewTargetId));
  const units = usePlanner((s) => s.units);
  const { setForm, startSearch, cancelSearch } = useUI.getState();
  const ids = { q: useId(), mount: useId(), style: useId(), price: useId() };

  const running = search.status === "running";
  const now = useNow(running);
  const elapsed = search.startedAt ? Math.max(0, Math.floor((now - search.startedAt) / 1000)) : 0;

  return (
    <div className="tab-body">
      <section className="section" aria-labelledby="find-h">
        <div className="section-head">
          <h2 id="find-h">Find real products</h2>
        </div>
        {target ? <TargetBanner target={target} units={units} /> : null}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void startSearch();
          }}
        >
          <Field label="What are you looking for?" htmlFor={ids.q}>
            <textarea
              id={ids.q}
              className="input textarea"
              data-testid="search-input"
              rows={3}
              placeholder="hanging lamp for the corner, Japanese style, warm light"
              value={form.query}
              onChange={(e) => setForm({ query: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  void startSearch();
                }
              }}
            />
          </Field>
          <div className="row-2">
            <Field label="Mount" htmlFor={ids.mount}>
              <select
                id={ids.mount}
                className="input select"
                data-testid="search-mount"
                value={form.mount}
                onChange={(e) => setForm({ mount: e.target.value as Mount | "any" })}
              >
                <option value="any">Any</option>
                <option value="floor">Floor</option>
                <option value="wall">Wall</option>
                <option value="ceiling">Ceiling</option>
              </select>
            </Field>
            <Field label="Max price" htmlFor={ids.price}>
              <div className="input-prefix">
                <span aria-hidden="true">$</span>
                <input
                  id={ids.price}
                  className="input"
                  data-testid="search-max-price"
                  type="number"
                  min={0}
                  step={10}
                  placeholder="no limit"
                  value={form.maxPrice}
                  onChange={(e) => setForm({ maxPrice: e.target.value })}
                />
              </div>
            </Field>
          </div>
          <Field label="Style" htmlFor={ids.style}>
            <input
              id={ids.style}
              className="input"
              data-testid="search-style"
              placeholder="any style"
              value={form.style}
              onChange={(e) => setForm({ style: e.target.value })}
            />
          </Field>
          <div className="suggest-chips" role="group" aria-label="Style suggestions">
            {STYLE_SUGGESTIONS.map((s) => (
              <button
                key={s}
                type="button"
                className={`chip chip-btn${form.style === s ? " active" : ""}`}
                data-testid={`style-chip-${s.toLowerCase().replace(/\s+/g, "-")}`}
                onClick={() => setForm({ style: form.style === s ? "" : s })}
              >
                {s}
              </button>
            ))}
          </div>

          {running ? (
            <div className="progress-card" data-testid="search-progress" role="status">
              <Spinner />
              <div className="progress-text">
                <strong>Searching the web… {elapsed}s</strong>
                <span className="muted small">Live search can take 1–2 minutes.</span>
              </div>
              <button type="button" className="btn btn-secondary btn-sm" data-testid="search-cancel-btn" onClick={cancelSearch}>
                Cancel
              </button>
            </div>
          ) : (
            <button type="submit" className="btn btn-primary btn-block" data-testid="search-btn" disabled={!form.query.trim()}>
              <Icon.search /> Search
            </button>
          )}
        </form>

        {search.status === "error" ? (
          <div className="inline-msg error" data-testid="search-error" role="alert">
            {search.error}
            {search.resend ? (
              <>
                {" "}
                <button type="button" className="btn btn-secondary btn-sm" data-testid="search-resend" onClick={() => void startSearch()}>
                  Resend
                </button>
              </>
            ) : null}
          </div>
        ) : null}
        {search.status === "cancelled" ? <div className="inline-msg small muted">Search cancelled.</div> : null}
        {inferred ? (
          <p className="muted small" data-testid="inferred-filters">
            Filled in from your description:{" "}
            {[
              inferred.maxPrice ? `max price $${inferred.maxPrice}` : null,
              inferred.mount ? `mount ${MOUNT_LABEL[inferred.mount]}` : null,
              inferred.placement === "corner" ? "placed in a free corner" : null,
            ]
              .filter(Boolean)
              .join(", ")}
            . Change the fields above to adjust.
          </p>
        ) : null}
      </section>

      {hasSearched ? (
        <section className="section results" aria-labelledby="results-h">
          <div className="section-head">
            <h2 id="results-h">Results</h2>
            <span className="muted small">
              {results.length}
              {mock ? " · demo data" : ""}
            </span>
          </div>
          {notes ? (
            <p className="muted small" data-testid="search-notes">
              {notes}
            </p>
          ) : null}
          {results.length === 0 ? <p className="muted">No products found. Try a broader description.</p> : null}
          <ul className="result-list">
            {results.map((c) => (
              <ResultCard key={c.id} c={c} />
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

/** Shown while searching "for" an item: results preview in its spot and can replace it. */
function TargetBanner({ target, units }: { target: PlacedItem; units: Units }) {
  return (
    <div className="inline-msg target-banner" data-testid="target-banner">
      <div>
        <strong>Finding a real “{target.name}”</strong>
        <div className="small muted">
          Placeholder {formatDims(target.dims, units)}, {MOUNT_LABEL[target.mount].toLowerCase()}. Previews appear in its spot; “Use here”
          swaps it.
        </div>
      </div>
      <button
        type="button"
        className="btn btn-secondary btn-sm"
        data-testid="target-clear-btn"
        onClick={() => {
          usePlanner.getState().setPreviewTarget(null);
          usePlanner.getState().setPreview(null);
        }}
      >
        Stop
      </button>
    </div>
  );
}

function ResultCard({ c }: { c: ProductCandidate }) {
  const units = usePlanner((s) => s.units);
  const room = usePlanner((s) => s.room);
  const previewing = usePlanner((s) => s.preview?.id === c.id);
  const targetId = usePlanner((s) => (s.items.some((it) => it.id === s.previewTargetId) ? s.previewTargetId : null));
  const { setPreview, addProduct, replaceItemWithProduct, select } = usePlanner.getState();
  const price = formatPrice(c.price, c.currency);
  const fit = fitNotes(c, room, units);

  return (
    <li className={`result-card${previewing ? " previewing" : ""}`} data-testid="result-card">
      <ProductImage src={httpUrl(c.imageUrl)} alt={c.name} product={c} />
      <div className="result-body">
        <div className="result-title-row">
          <h3 className="result-name">{c.name}</h3>
          {price ? <span className="price">{price}</span> : null}
        </div>
        <dl className="kv result-traits">
          <dt>Retailer</dt>
          <dd>{c.retailer}</dd>
          <dt>Size</dt>
          <dd>
            <DimsLine product={c} units={units} />
          </dd>
          <dt>Mount</dt>
          <dd>{MOUNT_LABEL[c.mount] ?? c.mount}</dd>
          {c.colors.length ? (
            <>
              <dt>Colors</dt>
              <dd>
                <Swatches colors={c.colors} />
              </dd>
            </>
          ) : null}
          {c.style.length ? (
            <>
              <dt>Style</dt>
              <dd>
                <Chips items={c.style} label="Style" />
              </dd>
            </>
          ) : null}
          {c.origin ? (
            <>
              <dt>Origin</dt>
              <dd data-testid="result-origin">{c.origin}</dd>
            </>
          ) : null}
          {c.materials.length ? (
            <>
              <dt>Materials</dt>
              <dd>{c.materials.join(", ")}</dd>
            </>
          ) : null}
        </dl>
        {fit.length ? (
          <ul className="fit-notes" data-testid="fit-notes">
            {fit.map((n) => (
              <li key={n.text} className={n.warn ? "warn" : undefined}>
                {n.warn ? <Badge tone="warn">check fit</Badge> : null} {n.text}
              </li>
            ))}
          </ul>
        ) : null}
        {c.summary ? <p className="small summary">{c.summary}</p> : null}
        <div className="result-actions">
          <button
            className={`btn btn-sm ${previewing ? "btn-accent-soft" : "btn-secondary"}`}
            data-testid="preview-btn"
            aria-pressed={previewing}
            onClick={() => setPreview(previewing ? null : c)}
          >
            {previewing ? "Hide preview" : "Preview"}
          </button>
          {targetId ? (
            <button
              className="btn btn-sm btn-primary"
              data-testid="use-here-btn"
              title="Replace the placeholder with this product, in the same spot"
              onClick={() => {
                replaceItemWithProduct(targetId, c);
                setPreview(null);
              }}
            >
              Use here
            </button>
          ) : null}
          <button
            className={`btn btn-sm ${targetId ? "btn-secondary" : "btn-primary"}`}
            data-testid="add-product-btn"
            onClick={() => {
              const id = addProduct(c);
              setPreview(null);
              select(id);
            }}
          >
            Add to room
          </button>
          {httpUrl(c.url) ? (
            <a className="link small" href={httpUrl(c.url)} target="_blank" rel="noopener noreferrer" data-testid="product-link">
              View product ↗
            </a>
          ) : null}
        </div>
      </div>
    </li>
  );
}
