/** A closed ring as flat `[x, y, x, y, ...]` coordinates, without repeating the first point. */
export type Ring = number[];

/** An outer boundary with its holes. Outer rings are counter-clockwise, holes clockwise. */
export interface Polygon {
  outer: Ring;
  holes: Ring[];
}

/** Signed area: positive when the ring runs counter-clockwise. */
export function ringArea(ring: ArrayLike<number>): number {
  let sum = 0;
  const n = ring.length;
  for (let i = 0; i < n; i += 2) {
    const j = i + 2 === n ? 0 : i + 2;
    sum += ring[i]! * ring[j + 1]! - ring[j]! * ring[i + 1]!;
  }
  return sum / 2;
}

export function polygonArea(polygon: Polygon): number {
  let area = Math.abs(ringArea(polygon.outer));
  for (const hole of polygon.holes) area -= Math.abs(ringArea(hole));
  return area;
}

export interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function ringBox(ring: ArrayLike<number>): Box {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < ring.length; i += 2) {
    const x = ring[i]!;
    const y = ring[i + 1]!;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

export function boxesOverlap(a: Box, b: Box): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

/** Even-odd point-in-ring test. */
export function pointInRing(x: number, y: number, ring: ArrayLike<number>): boolean {
  let inside = false;
  const n = ring.length;
  for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
    const xi = ring[i]!;
    const yi = ring[i + 1]!;
    const xj = ring[j]!;
    const yj = ring[j + 1]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function pointInPolygon(x: number, y: number, polygon: Polygon): boolean {
  if (!pointInRing(x, y, polygon.outer)) return false;
  for (const hole of polygon.holes) if (pointInRing(x, y, hole)) return false;
  return true;
}

/** Area-weighted centroid of a ring (falls back to the vertex average for degenerate rings). */
export function ringCentroid(ring: ArrayLike<number>): [number, number] {
  let cx = 0;
  let cy = 0;
  let area = 0;
  const n = ring.length;
  for (let i = 0; i < n; i += 2) {
    const j = i + 2 === n ? 0 : i + 2;
    const cross = ring[i]! * ring[j + 1]! - ring[j]! * ring[i + 1]!;
    area += cross;
    cx += (ring[i]! + ring[j]!) * cross;
    cy += (ring[i + 1]! + ring[j + 1]!) * cross;
  }
  if (Math.abs(area) < 1e-9) {
    let sx = 0;
    let sy = 0;
    for (let i = 0; i < n; i += 2) {
      sx += ring[i]!;
      sy += ring[i + 1]!;
    }
    return [sx / (n / 2), sy / (n / 2)];
  }
  return [cx / (3 * area), cy / (3 * area)];
}

/** Squared distance from a point to a segment. */
export function distanceToSegmentSq(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  let t = lengthSq > 0 ? ((px - ax) * dx + (py - ay) * dy) / lengthSq : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = ax + t * dx - px;
  const ey = ay + t * dy - py;
  return ex * ex + ey * ey;
}

/** Shortest distance from a point to the boundary of a ring. */
export function distanceToRing(px: number, py: number, ring: ArrayLike<number>): number {
  let best = Number.POSITIVE_INFINITY;
  const n = ring.length;
  for (let i = 0; i < n; i += 2) {
    const j = i + 2 === n ? 0 : i + 2;
    const d = distanceToSegmentSq(px, py, ring[i]!, ring[i + 1]!, ring[j]!, ring[j + 1]!);
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

/** Length of an open polyline. */
export function lineLength(line: ArrayLike<number>): number {
  let total = 0;
  for (let i = 2; i < line.length; i += 2) {
    total += Math.hypot(line[i]! - line[i - 2]!, line[i + 1]! - line[i - 1]!);
  }
  return total;
}

/** Deterministic pseudo-random generator (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable hash of an integer id into [0, 1). */
export function hash01(id: number, salt = 0): number {
  let h = (id ^ (salt * 0x9e3779b9)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
