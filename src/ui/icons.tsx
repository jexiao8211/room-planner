// Tiny inline SVG icons (stroke = currentColor) so we don't need an icon library.
import type { ReactNode } from "react";

function Svg({ children, size = 18 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const Icon = {
  undo: () => (
    <Svg>
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h11a5 5 0 0 1 0 10h-3" />
    </Svg>
  ),
  redo: () => (
    <Svg>
      <path d="m15 14 5-5-5-5" />
      <path d="M20 9H9a5 5 0 0 0 0 10h3" />
    </Svg>
  ),
  download: () => (
    <Svg>
      <path d="M12 4v11" />
      <path d="m7 10 5 5 5-5" />
      <path d="M5 20h14" />
    </Svg>
  ),
  upload: () => (
    <Svg>
      <path d="M12 20V9" />
      <path d="m7 14 5-5 5 5" />
      <path d="M5 4h14" />
    </Svg>
  ),
  reset: () => (
    <Svg>
      <path d="M4 12a8 8 0 1 0 2.3-5.6" />
      <path d="M4 4v4h4" />
    </Svg>
  ),
  eye: () => (
    <Svg size={16}>
      <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
    </Svg>
  ),
  eyeOff: () => (
    <Svg size={16}>
      <path d="M3 3l18 18" />
      <path d="M10.6 5.1A10.6 10.6 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.6 6.6A17 17 0 0 0 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.4-1.6" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
    </Svg>
  ),
  close: () => (
    <Svg size={16}>
      <path d="M6 6l12 12M18 6 6 18" />
    </Svg>
  ),
  lock: () => (
    <Svg size={16}>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </Svg>
  ),
  unlock: () => (
    <Svg size={16}>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 7.8-1.2" />
    </Svg>
  ),
  camera: () => (
    <Svg size={16}>
      <path d="M4 8h3l2-3h6l2 3h3v11H4Z" />
      <circle cx="12" cy="13" r="3.5" />
    </Svg>
  ),
  photo: () => (
    <Svg size={28}>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <circle cx="9" cy="10" r="1.6" />
      <path d="m21 16-5-5-8 8" />
    </Svg>
  ),
  search: () => (
    <Svg size={16}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m20 20-4.2-4.2" />
    </Svg>
  ),
  external: () => (
    <Svg size={14}>
      <path d="M14 4h6v6" />
      <path d="M20 4 10 14" />
      <path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
    </Svg>
  ),
  plus: () => (
    <Svg size={16}>
      <path d="M12 5v14M5 12h14" />
    </Svg>
  ),
  paperclip: () => (
    <Svg size={18}>
      <path d="m20 11.5-7.8 7.8a5 5 0 0 1-7.1-7.1l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8" />
    </Svg>
  ),
  send: () => (
    <Svg size={16}>
      <path d="M4 12 20 4l-6 16-3-7Z" />
      <path d="m11 13 9-9" />
    </Svg>
  ),
  sparkle: () => (
    <Svg size={16}>
      <path d="M12 3v4M12 17v4M3 12h4M17 12h4" />
      <path d="m12 8 1.5 2.5L16 12l-2.5 1.5L12 16l-1.5-2.5L8 12l2.5-1.5Z" />
    </Svg>
  ),
  logo: () => (
    <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="var(--accent)" />
      <path d="M8 21.5 16 26l8-4.5v-9L16 8l-8 4.5Z" fill="none" stroke="#fff" strokeWidth="2" strokeLinejoin="round" />
      <path d="M8 12.5 16 17l8-4.5M16 17v9" fill="none" stroke="#fff" strokeWidth="2" strokeLinejoin="round" opacity="0.75" />
    </svg>
  ),
};

/** Illustrations for the shape palette. Unknown keys fall back to a cube. */
export function ShapeIcon({ kind }: { kind: string }) {
  const common = { width: 40, height: 40, viewBox: "0 0 40 40", fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinejoin: "round" as const, strokeLinecap: "round" as const, "aria-hidden": true };
  switch (kind) {
    case "cylinder":
      return (
        <svg {...common}>
          <ellipse cx="20" cy="10" rx="10" ry="4" fill="var(--shape-fill)" />
          <path d="M10 10v19c0 2.2 4.5 4 10 4s10-1.8 10-4V10" fill="var(--shape-fill)" />
          <ellipse cx="20" cy="10" rx="10" ry="4" />
        </svg>
      );
    case "sphere":
      return (
        <svg {...common}>
          <circle cx="20" cy="20" r="12" fill="var(--shape-fill)" />
          <ellipse cx="20" cy="20" rx="12" ry="4.5" opacity="0.5" />
        </svg>
      );
    case "cone":
      return (
        <svg {...common}>
          <path d="M20 6 9 30c0 2.2 5 4 11 4s11-1.8 11-4Z" fill="var(--shape-fill)" />
          <path d="M9 30c0-2.2 5-4 11-4s11 1.8 11 4" opacity="0.5" />
        </svg>
      );
    case "bed":
      return (
        <svg {...common}>
          <path d="M6 14h4v8H6z" fill="var(--shape-fill)" />
          <path d="M10 20h24v8H10zM6 22h4v10M34 28v4" fill="var(--shape-fill)" />
          <rect x="12" y="16" width="8" height="4" rx="1.5" />
        </svg>
      );
    case "desk":
      return (
        <svg {...common}>
          <path d="M5 14h30v3H5z" fill="var(--shape-fill)" />
          <path d="M8 17v15M32 17v15M24 17v8h8" />
        </svg>
      );
    case "pendant":
      return (
        <svg {...common}>
          <path d="M20 3v13" />
          <path d="M11 26a9 9 0 0 1 18 0Z" fill="var(--shape-fill)" />
          <path d="M17 30h6" opacity="0.6" />
          <path d="M8 3h24" />
        </svg>
      );
    case "floorlamp":
      return (
        <svg {...common}>
          <path d="M13 5h14l3 9H10Z" fill="var(--shape-fill)" />
          <path d="M20 14v18" />
          <path d="M14 34c0-1.4 2.7-2.5 6-2.5s6 1.1 6 2.5Z" fill="var(--shape-fill)" />
        </svg>
      );
    case "tablelamp":
      return (
        <svg {...common}>
          <path d="M14 10h12l5 10H9Z" fill="var(--shape-fill)" />
          <path d="M20 20v9" />
          <path d="M13 33c0-2 3-3.5 7-3.5s7 1.5 7 3.5Z" fill="var(--shape-fill)" />
        </svg>
      );
    case "cat":
      return (
        <svg {...common}>
          <path d="M13 13 14 6l4 5h4l4-5 1 7c2 2 2 6 0 8H13c-2-2-2-6 0-8Z" fill="var(--shape-fill)" />
          <path d="M11 34c-2-4-1-11 4-13h10c5 2 6 9 4 13Z" fill="var(--shape-fill)" />
          <path d="M29 33c4 0 6-3 5-7" />
        </svg>
      );
    case "cattower":
      return (
        <svg {...common}>
          <path d="M8 34h24M10 22h20M12 9h16" />
          <path d="M14 34V22M26 22V9" />
          <rect x="20" y="25" width="9" height="9" rx="1" fill="var(--shape-fill)" />
        </svg>
      );
    case "frame":
      return (
        <svg {...common}>
          <rect x="7" y="9" width="26" height="20" rx="1.5" fill="var(--shape-fill)" />
          <path d="m11 25 6-7 5 5 3-3 4 5" />
          <circle cx="26" cy="14" r="1.8" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <path d="M20 5 33 12v15l-13 7-13-7V12Z" fill="var(--shape-fill)" />
          <path d="M7 12l13 7 13-7M20 19v15" />
        </svg>
      );
  }
}
