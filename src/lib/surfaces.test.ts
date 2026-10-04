// Part-aware support surfaces (ROUND3-SPEC §3, §7): surfaces from parts, levels, "under", hanging drops.
import { describe, expect, it } from "vitest";
import type { PlacedItem } from "../shared/types";
import { SHAPE_PRESETS, defaultRoom } from "./presets";
import {
  defaultHangDrop,
  findSurfaceAt,
  fitsAtSpot,
  pickLevel,
  seatHeight,
  setHangingDrop,
  settleStacks,
  supportSurfaces,
  surfaceName,
  surfaceNames,
  surfaceOptions,
  surfaceSpot,
  surfacesFor,
} from "./geometry";

function preset(key: string, id = key, over: Partial<PlacedItem> = {}): PlacedItem {
  const p = SHAPE_PRESETS.find((x) => x.key === key)!;
  return { id, name: p.label, position: { x: 0, y: 0, z: 0 }, rotationY: 0, dims: { ...p.dims }, color: p.color, mount: p.mount, parts: p.parts, origin: "shape", ...over };
}
function box(id: string, w: number, h: number, d: number, over: Partial<PlacedItem> = {}): PlacedItem {
  return { id, name: id, position: { x: 0, y: 0, z: 0 }, rotationY: 0, dims: { w, h, d }, color: "#888888", mount: "floor", parts: [], origin: "shape", ...over };
}
const ys = (list: { y: number }[]) => list.map((s) => Math.round(s.y * 1000) / 1000);

describe("supportSurfaces from parts", () => {
  it("desk: the top (its legs end under it) and the floor under it", () => {
    const desk = preset("desk");
    const all = supportSurfaces(desk);
    expect(all.map((s) => s.kind)).toEqual(["top", "under"]);
    expect(ys(all)).toEqual([0.75, 0]);
    // The top spans the whole desk.
    expect(all[0]).toMatchObject({ x0: -0.6, x1: 0.6, z0: -0.3, z1: 0.3 });
  });

  it("cat tower: top perch 1.5 m, middle platform ~0.9 m, condo roof, base plate; no room under it", () => {
    const tower = preset("cattower");
    const all = supportSurfaces(tower);
    expect(ys(all)).toEqual([1.5, 0.945, 0.675, 0.045]);
    expect(all.map((s) => s.kind)).toEqual(["top", "level", "level", "level"]);
    expect(surfaceNames(all)).toEqual(["top", "middle level", "bottom level", "base"]);
    // The posts (18% of its width) are not surfaces; the middle platform spans the whole tower.
    expect(all[1]).toMatchObject({ x0: -0.3, x1: 0.3 });
  });

  it("bed: the mattress is the top (the headboard's 13 cm edge is not a surface); nothing fits under it", () => {
    const bed = preset("bed");
    const all = supportSurfaces(bed);
    expect(ys(all)).toEqual([0.3]);
    expect(all[0].kind).toBe("top");
    expect(surfaceName(bed, 0.3)).toBe("top");
  });

  it("an item without parts, or with only round parts, keeps its bounding-box top", () => {
    expect(ys(supportSurfaces(box("b", 0.5, 0.5, 0.5)))).toEqual([0.5]);
    expect(ys(supportSurfaces(preset("cat")))).toEqual([0.3]);
    // A hanging lamp's shade is a sphere and its cord is thin: just its bbox top.
    expect(ys(supportSurfaces(preset("pendant")))).toEqual([0.9]);
  });
});

describe("what fits where", () => {
  const tower = preset("cattower");
  const cat = preset("cat", "cat");
  const desk = preset("desk");

  it("a cat fits on the top perch and the middle platform, not under the low condo roof or on the cramped base", () => {
    expect(ys(surfacesFor(cat, tower))).toEqual([1.5, 0.945]);
    // On the middle platform it is kept clear of the post that holds up the perch.
    const mid = supportSurfaces(tower)[1];
    const spot = surfaceSpot(cat, tower, mid)!;
    expect(spot).not.toBeNull();
    expect(fitsAtSpot(cat, tower, mid, spot, 0)).toBe(true);
    expect(fitsAtSpot(cat, tower, mid, { x: 0, z: 0 }, 0)).toBe(false); // the middle touches the post
  });

  it("a bin fits under a desk between its legs; a tall box does not; nothing fits under a solid box", () => {
    const bin = box("bin", 0.3, 0.35, 0.3);
    expect(surfacesFor(bin, desk).map((s) => s.kind)).toEqual(["top", "under"]);
    expect(surfacesFor(box("tall", 0.3, 0.8, 0.3), desk).map((s) => s.kind)).toEqual(["top"]);
    expect(surfacesFor(bin, box("solid", 1.2, 0.75, 0.6)).map((s) => s.kind)).toEqual(["top"]);
    // Not inside a leg: a spot right at the desk's end is refused.
    const under = supportSurfaces(desk)[1];
    expect(fitsAtSpot(bin, desk, under, { x: 0, z: 0 }, 0)).toBe(true);
    expect(fitsAtSpot(bin, desk, under, { x: 0.55, z: 0 }, 0)).toBe(false);
  });

  it("pickLevel: top / middle / bottom of a cat tower, falling back to the nearest level that fits", () => {
    const all = supportSurfaces(tower);
    const fits = surfacesFor(cat, tower);
    expect(pickLevel(all, fits, "top")).toMatchObject({ surface: { y: 1.5 }, exact: true });
    expect(pickLevel(all, fits, "middle")).toMatchObject({ surface: { y: expect.closeTo(0.945) }, exact: true });
    // The bottom level (the condo roof) is too low under the platform for a cat: the nearest level it fits on.
    expect(pickLevel(all, fits, "bottom")).toMatchObject({ surface: { y: expect.closeTo(0.945) }, exact: false });
    // A desk has no middle level.
    const deskAll = supportSurfaces(desk);
    expect(pickLevel(deskAll, surfacesFor(cat, desk), "middle")).toMatchObject({ surface: { y: 0.75 }, exact: false });
  });

  it("surfaceOptions lists every surface an item fits on, with names", () => {
    const opts = surfaceOptions(box("bin", 0.3, 0.35, 0.3), [desk, tower, box("bin", 0.3, 0.35, 0.3, { position: { x: 1, y: 0, z: 1 } })]);
    // Not under the condo roof (21 cm below the platform) or on the base (beside the condo box): too tight for it.
    expect(opts.map((o) => `${o.support.id}:${o.name}`)).toEqual(["cattower:top", "cattower:middle level", "desk:top", "desk:under"]);
  });
});

describe("stacks on lower surfaces", () => {
  const room = defaultRoom();

  it("seatHeight: a stored surface, else the support's top", () => {
    const tower = preset("cattower", "t", { position: { x: 0, y: 0, z: 0 } });
    expect(seatHeight({}, tower)).toBeCloseTo(1.5);
    expect(seatHeight({ supportSurfaceY: 0.945 }, tower)).toBeCloseTo(0.945);
    expect(seatHeight({ supportSurfaceY: 0 }, tower)).toBe(0);
  });

  it("moving / turning the support carries an item under it and one on its middle level, at their heights", () => {
    const desk = preset("desk", "desk", { position: { x: 0, y: 0, z: 0 } });
    const bin = box("bin", 0.3, 0.35, 0.3, { supportId: "desk", supportSurfaceY: 0, position: { x: 0.2, y: 0, z: 0 } });
    const tower = preset("cattower", "t", { position: { x: -1, y: 0, z: 0 } });
    const cat = preset("cat", "cat", { supportId: "t", supportSurfaceY: 0.945, position: { x: -1.1, y: 0.945, z: 0 } });
    const prev = [desk, bin, tower, cat];
    const next = prev.map((it) =>
      it.id === "desk" ? { ...it, position: { x: 0.5, y: 0, z: 0.5 } } : it.id === "t" ? { ...it, position: { x: -1, y: 0, z: -0.5 }, rotationY: Math.PI / 2 } : it,
    );
    const out = settleStacks(prev, next, room);
    const b = out.find((i) => i.id === "bin")!;
    expect(b).toMatchObject({ supportId: "desk", supportSurfaceY: 0 });
    expect(b.position).toEqual({ x: expect.closeTo(0.7), y: 0, z: expect.closeTo(0.5) });
    const c = out.find((i) => i.id === "cat")!;
    expect(c).toMatchObject({ supportId: "t", supportSurfaceY: 0.945 });
    expect(c.position.y).toBeCloseTo(0.945);
    expect(c.position.x).toBeCloseTo(-1);
    expect(c.position.z).toBeCloseTo(-0.5 + 0.1);
  });

  it("resizing a cat tower keeps the cat on its platform (the platform height scales)", () => {
    const tower = preset("cattower", "t");
    const cat = preset("cat", "cat", { supportId: "t", supportSurfaceY: 0.945, position: { x: -0.1, y: 0.945, z: 0 } });
    const out = settleStacks([tower, cat], [{ ...tower, dims: { ...tower.dims, h: 1.8 } }, cat], room);
    const c = out.find((i) => i.id === "cat")!;
    expect(c.supportSurfaceY).toBeCloseTo(0.945 * 1.2, 3);
    expect(c.position.y).toBeCloseTo(0.945 * 1.2, 3);
  });

  it("an item falling off a hidden support lands on the highest surface below it, part-aware", () => {
    const tower = preset("cattower", "t");
    const box1 = box("b", 0.3, 0.1, 0.3, { position: { x: -0.1, y: 1.5, z: 0 }, supportId: "t" });
    const shelf = box("shelf", 0.3, 0.3, 0.3, { position: { x: -0.1, y: 1.5, z: -0.1 }, supportId: "t" });
    const lamp = box("lamp", 0.1, 0.1, 0.1, { position: { x: -0.1, y: 1.8, z: -0.1 }, supportId: "shelf" });
    const out = settleStacks([tower, box1, shelf, lamp], [tower, box1, { ...shelf, hidden: true }, lamp], room);
    const l = out.find((i) => i.id === "lamp")!;
    // It falls onto the box on the perch (the highest surface below it).
    expect(l.supportId).toBe("b");
    expect(l.position.y).toBeCloseTo(1.6);
    // findSurfaceAt never picks "under" (a dropped item goes to the floor, not under a desk).
    const desk = preset("desk", "desk");
    expect(findSurfaceAt(box("x", 0.2, 0.2, 0.2, { position: { x: 0, y: 0.5, z: 0 } }), { x: 0, z: 0 }, [desk], 0.5)).toBeNull();
  });
});

describe("hanging from the ceiling", () => {
  const pendant = preset("pendant");

  it("lengthens and shortens a pendant's cord, keeping the shade's size", () => {
    const shadeH = 0.44 * 0.9;
    const longer = setHangingDrop(pendant.dims, pendant.parts, 1.2);
    expect(longer.dims.h).toBeCloseTo(1.2);
    expect(longer.drop).toBeCloseTo(1.2);
    const shade = longer.parts.find((p) => p.kind === "sphere")!;
    expect(shade.size.y * longer.dims.h).toBeCloseTo(shadeH, 4);
    const cord = longer.parts.find((p) => p.kind === "cylinder")!;
    expect((cord.center.y + cord.size.y / 2) * longer.dims.h).toBeCloseTo(1.2, 3);
    // Not shorter than the shade (plus a bit of cord).
    expect(setHangingDrop(pendant.dims, pendant.parts, 0.1).drop).toBeGreaterThan(shadeH);
    // At most `maxDrop`.
    expect(setHangingDrop(pendant.dims, pendant.parts, 3, 2.1).drop).toBeCloseTo(2.1);
  });

  it("adds a cord to something hung lower than its own height, and hangs it flush otherwise", () => {
    const b = box("b", 0.4, 0.3, 0.4);
    const flush = setHangingDrop(b.dims, b.parts, 0.3);
    expect(flush.dims.h).toBeCloseTo(0.3);
    const hung = setHangingDrop(b.dims, b.parts, 0.8);
    expect(hung.dims.h).toBeCloseTo(0.8);
    expect(hung.parts).toHaveLength(2);
    const body = hung.parts[0];
    expect(body.size.y * 0.8).toBeCloseTo(0.3, 4);
    expect(body.center.y * 0.8).toBeCloseTo(0.15, 4);
  });

  it("default drop: a lamp hangs like a pendant, other things flush, a hanging item keeps its drop", () => {
    expect(defaultHangDrop(box("b", 0.3, 0.4, 0.3), 2.44, true)).toBeCloseTo(2.44 - 1.9);
    expect(defaultHangDrop(box("b", 0.3, 0.4, 0.3), 2.44, false)).toBeCloseTo(0.4);
    expect(defaultHangDrop(pendant, 2.44, true)).toBeCloseTo(0.9);
  });
});
