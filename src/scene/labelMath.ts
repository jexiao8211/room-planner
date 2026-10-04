// Pure screen-space math for the HTML labels (unit-tested).

/** Gap (px) kept between a label and the edge of the visible 3D view. */
const EDGE = 6;

/**
 * Screen position of a label's anchor, slid inward so the whole label stays inside the visible part of the
 * view (left of any panel floating over the right edge, below the chips along the top, above the bottom). Labels sit centered
 * on the anchor or just above it (translateY(-50%)), so the vertical clamp allows for a full height above.
 */
export function clampLabelPosition(
  x: number,
  y: number,
  label: { width: number; height: number },
  view: { width: number; height: number; insetRight: number; insetTop?: number },
): [number, number] {
  const right = Math.max(label.width + 2 * EDGE, view.width - view.insetRight);
  const cx = Math.min(Math.max(x, label.width / 2 + EDGE), right - label.width / 2 - EDGE);
  // Below the chips along the top of the view, unless that would leave hardly any room.
  const top = Math.min(Math.max(EDGE, view.insetTop ?? 0), view.height / 3);
  const cy = Math.min(Math.max(y, label.height + top), view.height - label.height / 2 - EDGE);
  return [cx, cy];
}
