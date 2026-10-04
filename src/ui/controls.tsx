// Small reusable form controls shared by the panels.
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { Units } from "../shared/types";
import { formatLength, parseLength } from "../lib/units";

/** Format a length that may be negative (positions relative to the room center). */
export function formatSigned(meters: number, units: Units): string {
  if (Math.abs(meters) < 0.0005) return formatLength(0, units);
  return (meters < 0 ? "−" : "") + formatLength(Math.abs(meters), units);
}

/** parseLength plus an optional leading minus sign. */
export function parseSigned(text: string, units: Units, displayedMeters?: number): number | null {
  const t = text.trim().replace(/^[−–]/, "-");
  const neg = t.startsWith("-");
  const v = parseLength(neg ? t.slice(1) : t, units, displayedMeters);
  if (v == null) return null;
  return neg ? -v : v;
}

/** Ticking clock while `active` (for elapsed-seconds displays). */
export function useNow(active: boolean, intervalMs = 500): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [active, intervalMs]);
  return now;
}

export function Field({ label, htmlFor, children, hint }: { label: string; htmlFor?: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="field">
      <label className="field-label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint ? <div className="field-hint">{hint}</div> : null}
    </div>
  );
}

interface LengthInputProps {
  label: string;
  value: number;
  units: Units;
  onCommit: (meters: number) => void;
  testId?: string;
  signed?: boolean;
  min?: number;
  disabled?: boolean;
  compact?: boolean;
}

/**
 * Free-text length input. Shows the formatted value; while editing, accepts anything parseLength
 * understands (8' 2", 96", 2.4 m, 240 cm). A bare number is inches in imperial; in metric it is read in the
 * unit the field shows (so "1.25" in a field showing "1.22 m" is meters). While typing, a hint shows how the
 * text was understood ("= 1.25 m"). Commits on Enter or blur.
 */
export function LengthInput({ label, value, units, onCommit, testId, signed, min = 0.01, disabled, compact }: LengthInputProps) {
  const id = useId();
  const formatted = signed ? formatSigned(value, units) : formatLength(value, units);
  const [draft, setDraft] = useState<string | null>(null);
  const [bad, setBad] = useState<"parse" | "small" | null>(null);
  const parse = (t: string) => (signed ? parseSigned(t, units, value) : parseLength(t, units, value));
  const parsed = draft == null ? value : parse(draft);
  const tooSmall = (v: number) => !signed && v < min;
  const editing = draft != null && draft.trim() !== formatted;
  const problem = !editing ? null : parsed == null ? "parse" : tooSmall(parsed) ? "small" : null;
  const show = (m: number) => (signed ? formatSigned(m, units) : formatLength(m, units));

  // Enter/Escape blur the input; the blur handler runs before React re-renders, so it would still see
  // the old draft. This ref makes the blur after Enter/Escape a no-op (no double commit, Escape cancels).
  const settled = useRef(false);
  const commit = () => {
    if (settled.current) {
      settled.current = false;
      return;
    }
    if (draft == null) return;
    if (draft.trim() === formatted) {
      setDraft(null);
      return;
    }
    const v = parse(draft);
    if (v == null || tooSmall(v)) {
      setBad(v == null ? "parse" : "small");
      setDraft(null);
      return;
    }
    setBad(null);
    setDraft(null);
    if (Math.abs(v - value) > 1e-6) onCommit(v);
  };

  let hint: ReactNode = null;
  if (problem === "parse") hint = <div className="field-hint field-error">can't parse</div>;
  else if (problem === "small") hint = <div className="field-hint field-error">too small (min {formatLength(min, units)})</div>;
  else if (editing && parsed != null) {
    hint = (
      <div className="field-hint ok-text" data-testid={testId ? `${testId}-parsed` : undefined}>
        = {show(parsed)}
      </div>
    );
  } else if (bad === "parse") hint = <div className="field-hint field-error">can't parse — kept {formatted}</div>;
  else if (bad === "small") hint = <div className="field-hint field-error">too small (min {formatLength(min, units)}) — kept {formatted}</div>;

  return (
    <div className={`field${compact ? " field-compact" : ""}`}>
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className={`input${problem ? " input-invalid" : ""}`}
        data-testid={testId}
        type="text"
        inputMode="decimal"
        disabled={disabled}
        value={draft ?? formatted}
        onFocus={(e) => {
          setDraft(formatted);
          setBad(null);
          e.currentTarget.select();
        }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            commit();
            settled.current = true;
            e.currentTarget.blur();
          } else if (e.key === "Escape") {
            setDraft(null);
            setBad(null);
            settled.current = true;
            e.currentTarget.blur();
          }
        }}
      />
      {hint}
    </div>
  );
}

interface TextInputProps {
  label: string;
  value: string;
  onCommit: (v: string) => void;
  testId?: string;
  disabled?: boolean;
  placeholder?: string;
}

/** Text input that commits on blur/Enter (so typing doesn't create one undo step per keystroke). */
export function TextInput({ label, value, onCommit, testId, disabled, placeholder }: TextInputProps) {
  const id = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const cancelled = useRef(false); // Escape: the blur that follows must not commit the stale draft
  const commit = () => {
    if (!cancelled.current && draft != null && draft.trim() && draft !== value) onCommit(draft.trim());
    cancelled.current = false;
    setDraft(null);
  };
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className="input"
        data-testid={testId}
        type="text"
        disabled={disabled}
        placeholder={placeholder}
        value={draft ?? value}
        onFocus={() => setDraft(value)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          else if (e.key === "Escape") {
            cancelled.current = true;
            e.currentTarget.blur();
          }
        }}
      />
    </div>
  );
}

interface ColorInputProps {
  label: string;
  value: string;
  /** `first` is true for the first change of a picking session — commit an undo step then, update transiently after. */
  onChange: (hex: string, first: boolean) => void;
  testId?: string;
  disabled?: boolean;
}

export function ColorInput({ label, value, onChange, testId, disabled }: ColorInputProps) {
  const id = useId();
  const fresh = useRef(true);
  return (
    <div className="field field-color">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <div className="color-row">
        <input
          id={id}
          className="color-input"
          type="color"
          data-testid={testId}
          disabled={disabled}
          value={value}
          onFocus={() => (fresh.current = true)}
          onBlur={() => (fresh.current = true)}
          onChange={(e) => {
            onChange(e.target.value, fresh.current);
            fresh.current = false;
          }}
        />
        <span className="color-hex">{value.toUpperCase()}</span>
      </div>
    </div>
  );
}

export function Spinner() {
  return <span className="spinner" aria-hidden="true" />;
}

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "warn" | "accent" }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function formatPrice(price: number | undefined, currency = "USD"): string | null {
  if (price == null || !Number.isFinite(price)) return null;
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: price % 1 ? 2 : 0 }).format(price);
  } catch {
    return `${price} ${currency}`;
  }
}
