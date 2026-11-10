import {
  Clipper64,
  ClipperOffset,
  ClipType,
  EndType,
  FillRule,
  JoinType,
  type Path64,
  type Paths64,
  type PolyPath64,
  PolyTree64,
  rectClipLines,
  simplifyPaths,
} from "clipper2-ts";
import type { Polygon, Ring } from "./poly";

/** Clipper works on integers: one unit is a centimetre. */
export const SCALE = 100;

/** Regularized shapes live on a grid this many times finer: one unit is a millimetre. */
export const FINE = 10;

export type { Path64, Paths64 };

/** `zoom` is 1 for ordinary paths and `FINE` for regularized ones. */
export function toPath(ring: ArrayLike<number>, zoom = 1): Path64 {
  const unit = SCALE * zoom;
  const path: Path64 = new Array(ring.length / 2);
  for (let i = 0, p = 0; i < ring.length; i += 2, p++) {
    path[p] = { x: Math.round(ring[i]! * unit), y: Math.round(ring[i + 1]! * unit) };
  }
  return path;
}

export function fromPath(path: Path64, zoom = 1): Ring {
  const unit = SCALE * zoom;
  const ring: Ring = new Array(path.length * 2);
  for (let i = 0; i < path.length; i++) {
    ring[i * 2] = path[i]!.x / unit;
    ring[i * 2 + 1] = path[i]!.y / unit;
  }
  return ring;
}

function run(type: ClipType, subject: Paths64, clip: Paths64 | null, rule: FillRule): Paths64 {
  const clipper = new Clipper64();
  clipper.addSubject(subject);
  if (clip) clipper.addClip(clip);
  const solution: Paths64 = [];
  clipper.execute(type, rule, solution);
  return solution;
}

/** Merges overlapping shapes. Inputs must be consistently oriented (see `normalize`). */
export function union(paths: Paths64): Paths64 {
  return paths.length ? run(ClipType.Union, paths, null, FillRule.NonZero) : [];
}

/**
 * Turns the rings of one feature (outer and inner boundaries in any order and winding)
 * into clean paths: outers counter-clockwise, holes clockwise.
 */
export function normalize(rings: ArrayLike<number>[]): Paths64 {
  const paths: Paths64 = [];
  for (const ring of rings) if (ring.length >= 6) paths.push(toPath(ring));
  return paths.length ? run(ClipType.Union, paths, null, FillRule.EvenOdd) : [];
}

export function intersect(subject: Paths64, clip: Paths64): Paths64 {
  return subject.length && clip.length ? run(ClipType.Intersection, subject, clip, FillRule.NonZero) : [];
}

export function difference(subject: Paths64, clip: Paths64): Paths64 {
  if (!subject.length) return [];
  return clip.length ? run(ClipType.Difference, subject, clip, FillRule.NonZero) : subject;
}

function collect(node: PolyPath64, zoom: number, out: Polygon[]): void {
  for (let i = 0; i < node.count; i++) {
    const outerNode = node.child(i);
    const outer = outerNode.poly;
    if (!outer || outer.length < 3) continue;
    const polygon: Polygon = { outer: fromPath(outer, zoom), holes: [] };
    for (let h = 0; h < outerNode.count; h++) {
      const holeNode = outerNode.child(h);
      if (holeNode.poly && holeNode.poly.length >= 3) polygon.holes.push(fromPath(holeNode.poly, zoom));
      // Islands inside holes are top-level polygons again.
      collect(holeNode, zoom, out);
    }
    out.push(polygon);
  }
}

/** Groups clean paths into polygons with their holes. */
export function toPolygons(paths: Paths64, zoom = 1): Polygon[] {
  if (!paths.length) return [];
  const clipper = new Clipper64();
  clipper.addSubject(paths);
  const tree = new PolyTree64();
  clipper.execute(ClipType.Union, FillRule.NonZero, tree);
  const out: Polygon[] = [];
  collect(tree, zoom, out);
  return out;
}

/** All rings of the given paths as flat coordinate arrays (outers CCW, holes CW). */
export function toRings(paths: Paths64, zoom = 1): Ring[] {
  return paths.filter((path) => path.length >= 3).map((path) => fromPath(path, zoom));
}

/**
 * Buffers open polylines into ribbons `width` metres wide with rounded joins and ends.
 * The result is already merged into non-overlapping shapes.
 */
export function inflateLines(lines: Paths64, width: number): Paths64 {
  if (!lines.length) return [];
  const delta = (width / 2) * SCALE;
  const offset = new ClipperOffset(2, Math.max(3, delta * 0.04));
  offset.addPaths(lines, JoinType.Round, EndType.Round);
  const solution: Paths64 = [];
  offset.execute(delta, solution);
  return solution;
}

/** Grows (or, with a negative amount, shrinks) closed shapes by `amount` metres. */
export function inflatePolygons(paths: Paths64, amount: number, round = false): Paths64 {
  return offsetPolygons(paths, amount * SCALE, round);
}

function offsetPolygons(paths: Paths64, delta: number, round: boolean): Paths64 {
  if (!paths.length) return [];
  const offset = new ClipperOffset(2, Math.max(3, Math.abs(delta) * 0.04));
  offset.addPaths(paths, round ? JoinType.Round : JoinType.Miter, EndType.Polygon);
  const solution: Paths64 = [];
  offset.execute(delta, solution);
  return solution;
}

/**
 * Pulls outlines apart wherever they touch, pinch or overlap by a hair, and drops whatever is
 * thinner than that.
 *
 * Clipped shapes are full of such spots (two lakes sharing a node, a road cutting a wood right
 * to its edge) and a solid cannot be closed properly around a wall of no width. The shapes come
 * out `margin` metres smaller all around, which no print can show.
 *
 * The result is in `FINE` units: at the usual centimetre a margin this small would drown in
 * rounding. Convert it with `toRings(paths, FINE)`.
 */
export function regularize(paths: Paths64, margin = 0.01): Paths64 {
  if (!paths.length) return [];
  const unit = SCALE * FINE;
  const fine = paths.map((path) => path.map((point) => ({ x: point.x * FINE, y: point.y * FINE })));
  const shrunk = offsetPolygons(fine, -2 * margin * unit, false);
  const grown = offsetPolygons(shrunk, margin * unit, false);
  // Offsetting leaves the odd kink a unit or two wide: iron them out.
  return simplifyPaths(grown, 0.2 * margin * unit, true);
}

/** Cuts open polylines down to an axis-aligned rectangle given in metres. */
export function clipLinesToBox(
  lines: Paths64,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): Paths64 {
  if (!lines.length) return [];
  const rect = {
    left: Math.round(minX * SCALE),
    top: Math.round(minY * SCALE),
    right: Math.round(maxX * SCALE),
    bottom: Math.round(maxY * SCALE),
  };
  return rectClipLines(rect, lines);
}

/** Keeps the parts of open polylines that fall inside the clip shapes. */
export function clipLines(lines: Paths64, clip: Paths64): Paths64 {
  if (!lines.length || !clip.length) return [];
  const clipper = new Clipper64();
  clipper.addOpenSubject(lines);
  clipper.addClip(clip);
  const closed: Paths64 = [];
  const open: Paths64 = [];
  clipper.execute(ClipType.Intersection, FillRule.NonZero, closed, open);
  return open;
}

export function pathsArea(paths: Paths64): number {
  let total = 0;
  for (const path of paths) {
    let sum = 0;
    for (let i = 0, n = path.length; i < n; i++) {
      const a = path[i]!;
      const b = path[i + 1 === n ? 0 : i + 1]!;
      sum += a.x * b.y - b.x * a.y;
    }
    total += sum / 2;
  }
  return total / (SCALE * SCALE);
}
