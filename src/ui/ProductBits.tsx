import { useState } from "react";
import type { ColorSwatch, Dims, ProductCandidate, ShapePart, Units } from "../shared/types";
import { formatDims } from "../lib/units";
import { Badge } from "./controls";

export function Swatches({ colors }: { colors: ColorSwatch[] }) {
  if (!colors.length) return null;
  return (
    <ul className="swatches" aria-label="Colors">
      {colors.map((c, i) => (
        <li key={`${c.hex}-${i}`} className="swatch-chip" title={`${c.name} ${c.hex}`}>
          <span className="swatch" style={{ background: c.hex }} />
          <span>{c.name}</span>
        </li>
      ))}
    </ul>
  );
}

export function Chips({ items, label }: { items: string[]; label: string }) {
  if (!items.length) return null;
  return (
    <ul className="chips" aria-label={label}>
      {items.map((s, i) => (
        <li key={`${s}-${i}`} className="chip">
          {s}
        </li>
      ))}
    </ul>
  );
}

export function DimsLine({ product, units }: { product: ProductCandidate; units: Units }) {
  const estimated = product.dimsSource === "estimated";
  return (
    <div className="dims-line">
      <span>{formatDims(product.dims, units)}</span>
      {estimated ? (
        <span title="Dimensions estimated by AI — not listed on the product page">
          <Badge tone="warn">est.</Badge>
        </span>
      ) : (
        <Badge>listed</Badge>
      )}
    </div>
  );
}

/**
 * Front view (x/y) of an item's primitive parts as a small SVG — the card thumbnail when a product has no
 * photo (most demo products, and live results whose page had no og:image).
 */
export function Silhouette({ parts, dims, color }: { parts: ShapePart[]; dims: Dims; color: string }) {
  const pad = Math.max(dims.w, dims.h) * 0.06;
  const vb = `${-dims.w / 2 - pad} ${-dims.h - pad} ${dims.w + 2 * pad} ${dims.h + 2 * pad}`;
  return (
    <svg className="silhouette" viewBox={vb} preserveAspectRatio="xMidYMid meet" role="img" aria-label="Shape preview" data-testid="product-silhouette">
      {parts.map((p, i) => {
        const w = p.size.x * dims.w;
        const h = p.size.y * dims.h;
        const cx = p.center.x * dims.w;
        const cy = -p.center.y * dims.h; // SVG y grows downward
        const fill = p.color ?? color;
        const common = { fill, stroke: "rgba(0,0,0,0.25)", strokeWidth: Math.max(dims.w, dims.h) * 0.006 };
        if (p.kind === "sphere") return <ellipse key={i} cx={cx} cy={cy} rx={w / 2} ry={h / 2} {...common} />;
        if (p.kind === "cone") return <polygon key={i} points={`${cx},${cy - h / 2} ${cx - w / 2},${cy + h / 2} ${cx + w / 2},${cy + h / 2}`} {...common} />;
        return <rect key={i} x={cx - w / 2} y={cy - h / 2} width={w} height={h} rx={p.kind === "cylinder" ? Math.min(w, h) * 0.08 : 0} {...common} />;
      })}
    </svg>
  );
}

/**
 * Product photo; while it loads (or if it fails, or there is none) the shape silhouette stands in.
 * Keyed by src: a new search can reuse a card for another product, and the load state must not carry over.
 */
export function ProductImage({ src, alt, product }: { src?: string; alt: string; product?: ProductCandidate }) {
  return <ProductImageInner key={src ?? "none"} src={src} alt={alt} product={product} />;
}

function ProductImageInner({ src, alt, product }: { src?: string; alt: string; product?: ProductCandidate }) {
  const [state, setState] = useState<"loading" | "loaded" | "failed">("loading");
  const fallback = product ? <Silhouette parts={product.parts} dims={product.dims} color={product.colors[0]?.hex ?? "#999999"} /> : null;
  if (!src || state === "failed") return fallback ? <div className="product-img product-img-shape">{fallback}</div> : null;
  return (
    <div className={`product-img${state === "loaded" ? "" : " product-img-pending"}`}>
      <img src={src} alt={alt} referrerPolicy="no-referrer" onLoad={() => setState("loaded")} onError={() => setState("failed")} />
    </div>
  );
}
