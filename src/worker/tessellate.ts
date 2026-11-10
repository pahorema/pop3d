import earcut from "earcut";
import { pointInRing, type Ring, ringArea } from "./poly";

/** Axis-aligned grid the polygons are cut against. Lines must be strictly ascending. */
export interface Grid {
  xs: Float64Array;
  ys: Float64Array;
  /** How a full cell is split: 0 along south-west/north-east, 1 along south-east/north-west. */
  diagonal(ix: number, iy: number): number;
}

export interface Tessellation {
  /** Vertex coordinates as x, y pairs. */
  xy: number[];
  /** Counter-clockwise triangles, three vertex indices each. */
  triangles: number[];
  /** Outline segments as ax, ay, bx, by, with the surface on their left. */
  edges: number[];
}

/** Index of the strip `[lines[k], lines[k + 1]]` containing `value`. */
function locate(lines: Float64Array, value: number): number {
  const last = lines.length - 2;
  let k = Math.floor(((value - lines[0]!) / (lines[last + 1]! - lines[0]!)) * (last + 1));
  if (k < 0) k = 0;
  else if (k > last) k = last;
  while (k > 0 && lines[k]! > value) k--;
  while (k < last && lines[k + 1]! < value) k++;
  return k;
}

/**
 * Distributes a closed ring over the strips between consecutive grid lines.
 *
 * Every crossing with a line becomes a vertex lying exactly on it, shared by the two strips it
 * separates. Keeping, for each strip, the vertices that fall inside it (in order) is then
 * equivalent to Sutherland-Hodgman clipping: the result has the same winding numbers as the
 * original ring, with zero-width "bridges" running along the grid lines.
 */
function splitRing(ring: number[], lines: Float64Array, axis: 0 | 1, out: Map<number, number[]>): void {
  const last = lines.length - 2;
  const count = lines.length;

  const add = (x: number, y: number): void => {
    const value = axis === 0 ? x : y;
    const k = locate(lines, value);
    let a = k;
    let b = k;
    if (value === lines[k] && k > 0) a = k - 1;
    else if (value === lines[k + 1] && k < last) b = k + 1;
    for (let s = a; s <= b; s++) {
      let strip = out.get(s);
      if (!strip) out.set(s, (strip = []));
      strip.push(x, y);
    }
  };

  const n = ring.length;
  for (let i = 0; i < n; i += 2) {
    const j = i + 2 === n ? 0 : i + 2;
    const px = ring[i]!;
    const py = ring[i + 1]!;
    const qx = ring[j]!;
    const qy = ring[j + 1]!;
    add(px, py);
    const from = axis === 0 ? px : py;
    const to = axis === 0 ? qx : qy;
    if (from === to) continue;
    const otherFrom = axis === 0 ? py : px;
    const otherTo = axis === 0 ? qy : qx;
    const lo = Math.min(otherFrom, otherTo);
    const hi = Math.max(otherFrom, otherTo);
    const cross = (k: number): void => {
      const line = lines[k]!;
      let other = otherFrom + ((line - from) / (to - from)) * (otherTo - otherFrom);
      other = other < lo ? lo : other > hi ? hi : other;
      if (axis === 0) add(line, other);
      else add(other, line);
    };
    if (from < to) {
      let k = locate(lines, from) + 1;
      while (k < count && lines[k]! <= from) k++;
      for (; k < count && lines[k]! < to; k++) cross(k);
    } else {
      let k = locate(lines, from);
      while (k >= 0 && lines[k]! >= from) k--;
      for (; k >= 0 && lines[k]! > to; k--) cross(k);
    }
  }
}

function isSpike(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): boolean {
  const ux = bx - ax;
  const uy = by - ay;
  const vx = cx - bx;
  const vy = cy - by;
  return ux * vy - uy * vx === 0 && ux * vx + uy * vy < 0;
}

/** Drops repeated points and zero-width spikes left behind by the bridges. */
function clean(points: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < points.length; i += 2) {
    out.push(points[i]!, points[i + 1]!);
    for (;;) {
      const n = out.length;
      if (n >= 4 && out[n - 2] === out[n - 4] && out[n - 1] === out[n - 3]) {
        out.length = n - 2;
        continue;
      }
      if (n >= 6 && isSpike(out[n - 6]!, out[n - 5]!, out[n - 4]!, out[n - 3]!, out[n - 2]!, out[n - 1]!)) {
        out[n - 4] = out[n - 2]!;
        out[n - 3] = out[n - 1]!;
        out.length = n - 2;
        continue;
      }
      break;
    }
  }
  // The same defects can straddle the point where the ring closes.
  for (;;) {
    const n = out.length;
    if (n < 6) break;
    if (out[0] === out[n - 2] && out[1] === out[n - 1]) {
      out.length = n - 2;
      continue;
    }
    if (isSpike(out[n - 2]!, out[n - 1]!, out[0]!, out[1]!, out[2]!, out[3]!)) {
      out.splice(0, 2);
      continue;
    }
    if (isSpike(out[n - 4]!, out[n - 3]!, out[n - 2]!, out[n - 1]!, out[0]!, out[1]!)) {
      out.length = n - 2;
      continue;
    }
    break;
  }
  return out.length >= 6 ? out : [];
}

/**
 * Cuts polygons along a grid and triangulates the pieces.
 *
 * Cells entirely covered become two triangles on the grid vertices; cells crossed by an outline
 * are triangulated piece by piece. Because every layer of the model is cut along the same grid,
 * they all bend over the terrain at exactly the same places.
 *
 * @param rings Outer boundaries counter-clockwise and holes clockwise, not overlapping each other
 *   (the output of the clipper).
 */
export function tessellate(rings: Ring[], grid: Grid): Tessellation {
  const { xs, ys } = grid;
  const nx = xs.length - 1;
  const cells = new Map<number, number[][]>();
  const strips = new Map<number, number[]>();
  const pieces = new Map<number, number[]>();

  for (const ring of rings) {
    if (ring.length < 6) continue;
    strips.clear();
    splitRing(ring, ys, 1, strips);
    for (const [row, strip] of strips) {
      const cleaned = clean(strip);
      if (!cleaned.length) continue;
      pieces.clear();
      splitRing(cleaned, xs, 0, pieces);
      for (const [col, piece] of pieces) {
        const cell = clean(piece);
        if (!cell.length) continue;
        const key = row * nx + col;
        const list = cells.get(key);
        if (list) list.push(cell);
        else cells.set(key, [cell]);
      }
    }
  }

  const xy: number[] = [];
  const triangles: number[] = [];
  const edges: number[] = [];
  const lookup = new Map<number, number>();
  const originX = xs[0]!;
  const originY = ys[0]!;

  const vertex = (x: number, y: number): number => {
    const key = Math.round((x - originX) * 2000) * 67108864 + Math.round((y - originY) * 2000);
    let index = lookup.get(key);
    if (index === undefined) {
      index = xy.length / 2;
      xy.push(x, y);
      lookup.set(key, index);
    }
    return index;
  };

  const triangle = (a: number, b: number, c: number): void => {
    if (a !== b && b !== c && a !== c) triangles.push(a, b, c);
  };

  const emitPolygon = (outer: number[], holes: number[][]): void => {
    let coords = outer;
    let holeIndices: number[] | undefined;
    if (holes.length) {
      coords = outer.slice();
      holeIndices = [];
      for (const hole of holes) {
        holeIndices.push(coords.length / 2);
        for (let i = 0; i < hole.length; i++) coords.push(hole[i]!);
      }
    }
    const indices = coords.length === 6 ? [0, 1, 2] : earcut(coords, holeIndices);
    for (let i = 0; i < indices.length; i += 3) {
      const a = indices[i]! * 2;
      const b = indices[i + 1]! * 2;
      const c = indices[i + 2]! * 2;
      const ax = coords[a]!;
      const ay = coords[a + 1]!;
      const bx = coords[b]!;
      const by = coords[b + 1]!;
      const cx = coords[c]!;
      const cy = coords[c + 1]!;
      const cross = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      if (cross === 0) continue;
      if (cross > 0) triangle(vertex(ax, ay), vertex(bx, by), vertex(cx, cy));
      else triangle(vertex(ax, ay), vertex(cx, cy), vertex(bx, by));
    }
  };

  for (const [key, cellRings] of cells) {
    const col = key % nx;
    const row = (key - col) / nx;
    const x0 = xs[col]!;
    const x1 = xs[col + 1]!;
    const y0 = ys[row]!;
    const y1 = ys[row + 1]!;
    const cellArea = (x1 - x0) * (y1 - y0);
    const width = x1 - x0;
    const height = y1 - y0;

    let net = 0;
    const chains: number[][] = [];
    const loops: number[][] = [];

    for (const ring of cellRings) {
      const m = ring.length / 2;
      const bridge = (i: number): boolean => {
        const j = i + 1 === m ? 0 : i + 1;
        const ax = ring[i * 2]!;
        const ay = ring[i * 2 + 1]!;
        return (
          (ax === ring[j * 2] && (ax === x0 || ax === x1)) ||
          (ay === ring[j * 2 + 1] && (ay === y0 || ay === y1))
        );
      };
      let firstBridge = -1;
      let bridges = 0;
      for (let i = 0; i < m; i++) {
        if (bridge(i)) {
          if (firstBridge < 0) firstBridge = i;
          bridges++;
        }
      }
      if (bridges === 0) {
        loops.push(ring);
        continue;
      }
      if (bridges === m) {
        // The ring runs all around the cell: it either covers it or (as a hole) empties it.
        const area = ringArea(ring);
        if (Math.abs(area) > cellArea * 0.5) net += area > 0 ? 1 : -1;
        continue;
      }
      let current: number[] | null = null;
      for (let step = 1; step <= m; step++) {
        const i = (firstBridge + step) % m;
        if (bridge(i)) {
          if (current) chains.push(current);
          current = null;
          continue;
        }
        const j = i + 1 === m ? 0 : i + 1;
        if (!current) current = [ring[i * 2]!, ring[i * 2 + 1]!];
        current.push(ring[j * 2]!, ring[j * 2 + 1]!);
      }
      if (current) chains.push(current);
    }

    if (!chains.length && !loops.length) {
      if (net <= 0) continue;
      const sw = vertex(x0, y0);
      const se = vertex(x1, y0);
      const ne = vertex(x1, y1);
      const nw = vertex(x0, y1);
      if (grid.diagonal(col, row) === 0) {
        triangles.push(sw, se, ne, sw, ne, nw);
      } else {
        triangles.push(sw, se, nw, se, ne, nw);
      }
      continue;
    }

    for (const chain of chains) {
      for (let i = 0; i + 3 < chain.length; i += 2) {
        edges.push(chain[i]!, chain[i + 1]!, chain[i + 2]!, chain[i + 3]!);
      }
    }
    for (const loop of loops) {
      const n = loop.length;
      for (let i = 0; i < n; i += 2) {
        const j = i + 2 === n ? 0 : i + 2;
        edges.push(loop[i]!, loop[i + 1]!, loop[j]!, loop[j + 1]!);
      }
    }

    const outers: number[][] = [];
    if (chains.length) {
      // Position of a boundary point along the cell outline, counter-clockwise from the
      // south-west corner: [0, 1) bottom, [1, 2) right, [2, 3) top, [3, 4) left.
      const param = (x: number, y: number): number => {
        if (y === y0) return (x - x0) / width;
        if (x === x1) return 1 + (y - y0) / height;
        if (y === y1) return 2 + (x1 - x) / width;
        return 3 + (y1 - y) / height;
      };
      const count = chains.length;
      const starts = new Float64Array(count);
      const ends = new Float64Array(count);
      for (let i = 0; i < count; i++) {
        const chain = chains[i]!;
        starts[i] = param(chain[0]!, chain[1]!);
        ends[i] = param(chain[chain.length - 2]!, chain[chain.length - 1]!);
      }
      const order = Array.from({ length: count }, (_, i) => i).sort((a, b) => starts[a]! - starts[b]!);
      const used = new Uint8Array(count);
      const cornerX = [x0, x1, x1, x0];
      const cornerY = [y0, y0, y1, y1];

      for (let first = 0; first < count; first++) {
        if (used[first]) continue;
        const polygon: number[] = [];
        let current = first;
        for (let guard = 0; guard <= count; guard++) {
          used[current] = 1;
          const chain = chains[current]!;
          for (let i = 0; i < chain.length; i++) polygon.push(chain[i]!);
          // Follow the cell outline counter-clockwise up to the next chain entering the cell.
          const exit = ends[current]!;
          let next = -1;
          let target = 0;
          for (const candidate of order) {
            if (starts[candidate]! >= exit && (!used[candidate] || candidate === first)) {
              next = candidate;
              target = starts[candidate]!;
              break;
            }
          }
          if (next < 0) {
            for (const candidate of order) {
              if (!used[candidate] || candidate === first) {
                next = candidate;
                target = starts[candidate]! + 4;
                break;
              }
            }
          }
          if (next < 0) break;
          for (let corner = Math.floor(exit) + 1; corner < target; corner++) {
            if (corner > exit) polygon.push(cornerX[corner % 4]!, cornerY[corner % 4]!);
          }
          if (next === first) break;
          current = next;
        }
        const cleaned = clean(polygon);
        if (cleaned.length && ringArea(cleaned) > 1e-7) outers.push(cleaned);
      }
    } else if (net > 0) {
      outers.push([x0, y0, x1, y0, x1, y1, x0, y1]);
    }

    const holes: number[][] = [];
    for (const loop of loops) {
      const area = ringArea(loop);
      if (area > 1e-7) outers.push(loop);
      else if (area < -1e-7) holes.push(loop);
    }

    if (!holes.length) {
      for (const outer of outers) emitPolygon(outer, []);
      continue;
    }
    const owned: number[][][] = outers.map(() => []);
    for (const hole of holes) {
      let owner = -1;
      let ownerArea = Number.POSITIVE_INFINITY;
      for (let i = 0; i < outers.length; i++) {
        if (!pointInRing(hole[0]!, hole[1]!, outers[i]!)) continue;
        const area = ringArea(outers[i]!);
        if (area < ownerArea) {
          owner = i;
          ownerArea = area;
        }
      }
      if (owner >= 0) owned[owner]!.push(hole);
    }
    for (let i = 0; i < outers.length; i++) emitPolygon(outers[i]!, owned[i]!);
  }

  return { xy, triangles, edges };
}
