import { difference, type Paths64, toPath, union } from "./clip";
import { type Box, type Ring, ringArea } from "./poly";

/** Joins coastline ways head to tail, keeping their direction (land on the left). */
function mergeChains(ways: Ring[]): Ring[] {
  const key = (x: number, y: number) => `${x},${y}`;
  const byStart = new Map<string, number>();
  ways.forEach((way, index) => {
    if (way.length >= 4) byStart.set(key(way[0]!, way[1]!), index);
  });
  const hasPredecessor = new Uint8Array(ways.length);
  ways.forEach((way) => {
    const next = byStart.get(key(way[way.length - 2]!, way[way.length - 1]!));
    if (next !== undefined) hasPredecessor[next] = 1;
  });

  const used = new Uint8Array(ways.length);
  const chains: Ring[] = [];
  const follow = (start: number): void => {
    const chain = ways[start]!.slice();
    used[start] = 1;
    for (;;) {
      const next = byStart.get(key(chain[chain.length - 2]!, chain[chain.length - 1]!));
      if (next === undefined || used[next]) break;
      used[next] = 1;
      const way = ways[next]!;
      for (let i = 2; i < way.length; i++) chain.push(way[i]!);
    }
    chains.push(chain);
  };
  // Open chains first (from ways nobody leads into), then whatever is left: closed loops.
  ways.forEach((way, index) => {
    if (way.length >= 4 && !hasPredecessor[index]) follow(index);
  });
  ways.forEach((way, index) => {
    if (way.length >= 4 && !used[index]) follow(index);
  });
  return chains;
}

interface Piece {
  points: number[];
  /** True when both ends lie on the box outline. */
  anchored: boolean;
}

/** Cuts a polyline to the box; every crossing is snapped exactly onto the box outline. */
function clipChain(chain: Ring, box: Box): Piece[] {
  const pieces: Piece[] = [];
  let current: number[] | null = null;
  let startsOnEdge = false;
  const { minX, minY, maxX, maxY } = box;

  const snap = (x: number, y: number): [number, number] => {
    const dl = Math.abs(x - minX);
    const dr = Math.abs(x - maxX);
    const db = Math.abs(y - minY);
    const dt = Math.abs(y - maxY);
    const nearest = Math.min(dl, dr, db, dt);
    if (nearest === dl) return [minX, Math.min(maxY, Math.max(minY, y))];
    if (nearest === dr) return [maxX, Math.min(maxY, Math.max(minY, y))];
    if (nearest === db) return [Math.min(maxX, Math.max(minX, x)), minY];
    return [Math.min(maxX, Math.max(minX, x)), maxY];
  };

  for (let i = 0; i + 3 < chain.length; i += 2) {
    const px = chain[i]!;
    const py = chain[i + 1]!;
    const dx = chain[i + 2]! - px;
    const dy = chain[i + 3]! - py;
    // Liang-Barsky: the part of the segment inside the box is [t0, t1].
    let t0 = 0;
    let t1 = 1;
    let visible = true;
    const edges = [-dx, px - minX, dx, maxX - px, -dy, py - minY, dy, maxY - py];
    for (let e = 0; e < 8 && visible; e += 2) {
      const p = edges[e]!;
      const q = edges[e + 1]!;
      if (p === 0) {
        if (q < 0) visible = false;
      } else {
        const r = q / p;
        if (p < 0) {
          if (r > t1) visible = false;
          else if (r > t0) t0 = r;
        } else {
          if (r < t0) visible = false;
          else if (r < t1) t1 = r;
        }
      }
    }
    if (!visible) {
      if (current) pieces.push({ points: current, anchored: false });
      current = null;
      continue;
    }
    if (!current) {
      if (t0 > 0) {
        current = snap(px + dx * t0, py + dy * t0);
        startsOnEdge = true;
      } else {
        current = [px, py];
        startsOnEdge = false;
      }
    }
    if (t1 < 1) {
      current.push(...snap(px + dx * t1, py + dy * t1));
      pieces.push({ points: current, anchored: startsOnEdge });
      current = null;
    } else {
      current.push(px + dx, py + dy);
    }
  }
  if (current) pieces.push({ points: current, anchored: false });
  return pieces;
}

/**
 * Rebuilds the sea as polygons from OSM coastlines, which are mere lines with land on their
 * left and water on their right.
 *
 * Coastlines crossing the box are closed by walking along its outline with the water kept
 * inside; closed loops are islands (counter-clockwise) or enclosed seas (clockwise).
 */
export function seaPolygons(coastlines: Ring[], box: Box): Paths64 {
  if (!coastlines.length) return [];
  const { minX, minY, maxX, maxY } = box;
  const width = maxX - minX;
  const height = maxY - minY;

  const islands: Ring[] = [];
  const seas: Ring[] = [];
  // Pieces reversed so that the water is on their left.
  const chains: number[][] = [];

  for (const chain of mergeChains(coastlines)) {
    const n = chain.length;
    const closed = n >= 8 && chain[0] === chain[n - 2] && chain[1] === chain[n - 1];
    const pieces = clipChain(chain, box);
    const whole = pieces.length === 1 && pieces[0]!.points.length === n;
    if (closed && whole) {
      const ring = chain.slice(0, n - 2);
      (ringArea(ring) > 0 ? islands : seas).push(ring);
      continue;
    }
    // A closed loop cut by the box starts mid-way: stitch its last piece to its first.
    if (closed && pieces.length >= 2) {
      const first = pieces[0]!;
      const last = pieces[pieces.length - 1]!;
      if (!first.anchored && !last.anchored) {
        pieces.pop();
        first.points = [...last.points, ...first.points.slice(2)];
        first.anchored = true;
      }
    }
    for (const piece of pieces) {
      if (!piece.anchored || piece.points.length < 4) continue;
      const reversed: number[] = [];
      for (let i = piece.points.length - 2; i >= 0; i -= 2)
        reversed.push(piece.points[i]!, piece.points[i + 1]!);
      chains.push(reversed);
    }
  }

  const polygons: Ring[] = [];
  if (chains.length) {
    const param = (x: number, y: number): number => {
      if (y === minY) return (x - minX) / width;
      if (x === maxX) return 1 + (y - minY) / height;
      if (y === maxY) return 2 + (maxX - x) / width;
      return 3 + (maxY - y) / height;
    };
    const count = chains.length;
    const starts = chains.map((c) => param(c[0]!, c[1]!));
    const ends = chains.map((c) => param(c[c.length - 2]!, c[c.length - 1]!));
    const order = starts.map((_, i) => i).sort((a, b) => starts[a]! - starts[b]!);
    const used = new Uint8Array(count);
    const cornerX = [minX, maxX, maxX, minX];
    const cornerY = [minY, minY, maxY, maxY];

    for (let first = 0; first < count; first++) {
      if (used[first]) continue;
      const polygon: number[] = [];
      let current = first;
      for (let guard = 0; guard <= count; guard++) {
        used[current] = 1;
        polygon.push(...chains[current]!);
        const exit = ends[current]!;
        let next = order.find((c) => starts[c]! >= exit && (!used[c] || c === first));
        let target = next === undefined ? 0 : starts[next]!;
        if (next === undefined) {
          next = order.find((c) => !used[c] || c === first);
          if (next === undefined) break;
          target = starts[next]! + 4;
        }
        for (let corner = Math.floor(exit) + 1; corner < target; corner++) {
          polygon.push(cornerX[corner % 4]!, cornerY[corner % 4]!);
        }
        if (next === first) break;
        current = next;
      }
      if (polygon.length >= 6) polygons.push(polygon);
    }
  } else if (islands.length && !seas.length) {
    // Only islands in sight: the box sits in open water.
    polygons.push([minX, minY, maxX, minY, maxX, maxY, minX, maxY]);
  }

  const water = union(
    [...polygons, ...seas].map((ring) => {
      const path = toPath(ring);
      return ringArea(ring) < 0 ? path.reverse() : path;
    }),
  );
  if (!islands.length) return water;
  return difference(water, union(islands.map(toPath)));
}
