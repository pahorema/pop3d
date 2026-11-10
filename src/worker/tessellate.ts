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
      // Always interpolate from the lower end: an edge shared by two outlines, which walk it in
      // opposite directions, is then cut at the very same point in both.
      let other =
        from < to
          ? otherFrom + ((line - from) / (to - from)) * (otherTo - otherFrom)
          : otherTo + ((line - to) / (from - to)) * (otherFrom - otherTo);
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

/** Drops the points of a closed outline that repeat the one before them. */
function distinct(points: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < points.length; i += 2) {
    const n = out.length;
    if (n && out[n - 2] === points[i] && out[n - 1] === points[i + 1]) continue;
    out.push(points[i]!, points[i + 1]!);
  }
  while (out.length >= 4 && out[0] === out[out.length - 2] && out[1] === out[out.length - 1]) {
    out.length -= 2;
  }
  return out;
}

/**
 * Removes the points of a polyline that lie exactly on the segment joining their neighbours
 * (the same test the triangulator applies), keeping the ends of open ones.
 */
export function straighten(points: number[], closed: boolean): number[] {
  const out: number[] = [];
  const n = points.length / 2;
  for (let i = 0; i < n; i++) {
    const edge = !closed && (i === 0 || i === n - 1);
    if (!edge && n > 3) {
      // Compare with the last point kept, so that runs of collinear points collapse fully.
      const previous = out.length ? -1 : (i + n - 1) % n;
      const next = (i + 1) % n;
      const ax = previous < 0 ? out[out.length - 2]! : points[previous * 2]!;
      const ay = previous < 0 ? out[out.length - 1]! : points[previous * 2 + 1]!;
      const bx = points[i * 2]!;
      const by = points[i * 2 + 1]!;
      const cx = points[next * 2]!;
      const cy = points[next * 2 + 1]!;
      if ((by - ay) * (cx - bx) - (bx - ax) * (cy - by) === 0) continue;
    }
    out.push(points[i * 2]!, points[i * 2 + 1]!);
  }
  return out.length >= (closed ? 6 : 4) ? out : points;
}

/**
 * Triangulates an outline the regular triangulator gave up on: one that crosses or overlaps
 * itself by a hair. Ears are cut off one at a time, proper ones first; when none is left, the
 * thinnest sliver goes, whichever way it is wound. Triangles follow the outline, so that they
 * are bounded by it edge for edge however degenerate the shape is.
 */
function clipEars(coords: number[], sign: number, out: number[]): void {
  const ring: number[] = [];
  for (let i = 0; i < coords.length / 2; i++) ring.push(i);
  const cross = (a: number, b: number, c: number): number =>
    (coords[b * 2]! - coords[a * 2]!) * (coords[c * 2 + 1]! - coords[a * 2 + 1]!) -
    (coords[b * 2 + 1]! - coords[a * 2 + 1]!) * (coords[c * 2]! - coords[a * 2]!);
  // Past a few hundred corners (never seen in practice) settle for the thinnest slivers.
  const careful = ring.length <= 256;
  while (ring.length > 3) {
    const n = ring.length;
    let best = -1;
    let thinnest = Number.POSITIVE_INFINITY;
    let proper = false;
    for (let i = 0; i < n && !proper; i++) {
      const a = ring[(i + n - 1) % n]!;
      const b = ring[i]!;
      const c = ring[(i + 1) % n]!;
      const area = cross(a, b, c) * sign;
      if (careful && area > 0) {
        // A proper ear holds no other corner of the outline.
        proper = true;
        for (let k = 0; k < n && proper; k++) {
          const p = ring[k]!;
          if (p === a || p === b || p === c) continue;
          if (cross(a, b, p) * sign > 0 && cross(b, c, p) * sign > 0 && cross(c, a, p) * sign > 0) {
            proper = false;
          }
        }
        if (proper) best = i;
      }
      if (!proper && Math.abs(area) < thinnest) {
        thinnest = Math.abs(area);
        best = i;
      }
    }
    out.push(ring[(best + n - 1) % n]!, ring[best]!, ring[(best + 1) % n]!);
    ring.splice(best, 1);
  }
  out.push(ring[0]!, ring[1]!, ring[2]!);
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
  // Vertices are welded on their exact coordinates: points shared by neighbouring cells are
  // copies of the same numbers, and rounding them would let surfaces drift from their walls.
  const columns = new Map<number, Map<number, number>>();

  const vertex = (x: number, y: number): number => {
    let column = columns.get(x);
    if (!column) columns.set(x, (column = new Map()));
    let index = column.get(y);
    if (index === undefined) {
      index = xy.length / 2;
      xy.push(x, y);
      column.set(y, index);
    }
    return index;
  };

  const triangle = (a: number, b: number, c: number): void => {
    if (a !== b && b !== c && a !== c) triangles.push(a, b, c);
  };

  // Scratch storage for `emitPolygon`.
  const ids: number[] = [];
  const first: number[] = [];
  const pending: number[] = [];
  const slotOf: number[] = [];
  const stampOf: number[] = [];
  let stamp = 0;
  let tally = new Int16Array(256);
  let span = 0;
  /** Adds an edge between two corners of the polygon being checked to the tally. */
  const tick = (from: number, to: number, weight: number): void => {
    const a = first[from]!;
    const b = first[to]!;
    if (a < b) tally[a * span + b]! += weight;
    else if (b < a) tally[b * span + a]! -= weight;
  };

  /**
   * Triangulates one polygon of a cell. `sign` tells which way its outline runs: 1 for the
   * regular counter-clockwise one, -1 for an inverted sliver, 0 when it has no area at all.
   *
   * Whatever the shape, the triangles always end up bounded by the outline edge for edge: this
   * is what lets walls and neighbouring cells close the surface without a single gap.
   */
  const emitPolygon = (outer: number[], holes: number[][], sign = 1): void => {
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
    const count = coords.length / 2;
    // Points sharing their coordinates are one vertex.
    stamp++;
    for (let i = 0; i < count; i++) {
      const id = vertex(coords[i * 2]!, coords[i * 2 + 1]!);
      ids[i] = id;
      if (stampOf[id] !== stamp) {
        stampOf[id] = stamp;
        slotOf[id] = i;
      }
      first[i] = slotOf[id]!;
    }

    pending.length = 0;
    let sound = false;
    if (sign !== 0) {
      // The triangulator winds all its triangles the same way: find out which, from the first
      // one that has an area, and turn them all to follow the outline.
      const indices = count === 3 ? [0, 1, 2] : earcut(coords, holeIndices);
      let turn = 0;
      for (let i = 0; i < indices.length && turn === 0; i += 3) {
        const a = indices[i]! * 2;
        const b = indices[i + 1]! * 2;
        const c = indices[i + 2]! * 2;
        const cross =
          (coords[b]! - coords[a]!) * (coords[c + 1]! - coords[a + 1]!) -
          (coords[b + 1]! - coords[a + 1]!) * (coords[c]! - coords[a]!);
        if (cross !== 0) turn = cross * sign > 0 ? 1 : -1;
      }
      sound = turn !== 0;
      for (let i = 0; sound && i < indices.length; i += 3) {
        if (turn > 0) pending.push(indices[i]!, indices[i + 1]!, indices[i + 2]!);
        else pending.push(indices[i]!, indices[i + 2]!, indices[i + 1]!);
      }
    }
    if (sound && count > 3) {
      // The triangles must be bounded by the outline, edge for edge.
      const size = count * count;
      if (tally.length < size) tally = new Int16Array(size);
      else tally.fill(0, 0, size);
      span = count;
      let begin = 0;
      for (let h = 0; h <= holes.length; h++) {
        const end = h < holes.length ? holeIndices![h]! : count;
        if (h > 0) begin = holeIndices![h - 1]!;
        for (let i = begin; i < end; i++) tick(i, i + 1 === end ? begin : i + 1, -1);
      }
      for (let i = 0; i < pending.length; i += 3) {
        tick(pending[i]!, pending[i + 1]!, 1);
        tick(pending[i + 1]!, pending[i + 2]!, 1);
        tick(pending[i + 2]!, pending[i]!, 1);
      }
      for (let i = 0; i < size; i++) {
        if (tally[i] !== 0) {
          sound = false;
          break;
        }
      }
    }
    if (!sound && !holes.length) {
      pending.length = 0;
      clipEars(coords, sign, pending);
    }
    for (let i = 0; i < pending.length; i += 3) {
      triangle(ids[pending[i]!]!, ids[pending[i + 1]!]!, ids[pending[i + 2]!]!);
    }
  };

  // ---- Closing chains into polygons -----------------------------------------------------------
  // Scratch storage, reused from cell to cell.
  // Marks: the points of the cell outline where something starts or ends.
  let markAt = new Float64Array(64);
  let markX = new Float64Array(64);
  let markY = new Float64Array(64);
  let markNode = new Int32Array(64);
  let markOrder = new Int32Array(64);
  let markCount = 0;
  // Stops: the marks in order along the outline, each position once.
  let stopX = new Float64Array(64);
  let stopY = new Float64Array(64);
  let cover = new Int32Array(64);
  let head = new Int32Array(64);
  let seen = new Int32Array(64);
  let stops = 0;
  // Chains of the cell and the marks they start and end at.
  let chains: number[][] = [];
  let chainFrom: number[] = [];
  let chainTo: number[] = [];
  let origin = new Int32Array(16);
  let target = new Int32Array(16);
  let link = new Int32Array(16);
  let used = new Uint8Array(16);
  let outers: number[][] = [];
  let slivers: number[][] = [];
  const trail: number[] = [];
  const sizes: number[] = [];
  const polygon: number[] = [];

  const addMark = (position: number, x: number, y: number): number => {
    if (markCount === markAt.length) {
      const grow = (old: Float64Array): Float64Array<ArrayBuffer> => {
        const next = new Float64Array(old.length * 2);
        next.set(old);
        return next;
      };
      markAt = grow(markAt);
      markX = grow(markX);
      markY = grow(markY);
      markNode = new Int32Array(markAt.length);
      markOrder = new Int32Array(markAt.length);
      stopX = new Float64Array(markAt.length);
      stopY = new Float64Array(markAt.length);
      cover = new Int32Array(markAt.length);
      head = new Int32Array(markAt.length);
      seen = new Int32Array(markAt.length);
    }
    markAt[markCount] = position;
    markX[markCount] = x;
    markY[markCount] = y;
    return markCount++;
  };

  const close = (points: number[]): void => {
    const loop = distinct(points);
    if (loop.length < 6) return;
    if (ringArea(loop) > 0) outers.push(loop);
    else slivers.push(loop);
  };

  // Chains and covered stretches of outline form closed circuits: follow them, peeling off a
  // polygon every time the walk comes back to a stop it has already been through.
  const walk = (start: number): void => {
    let node = start;
    let byChain = false;
    for (;;) {
      const at = seen[node]!;
      if (at >= 0) {
        close(polygon.splice(sizes[at]!));
        for (let i = trail.length - 1; i > at; i--) seen[trail[i]!] = -1;
        trail.length = at + 1;
        sizes.length = at + 1;
      } else {
        seen[node] = trail.length;
        trail.push(node);
        sizes.push(polygon.length);
      }
      let chain = -1;
      for (let c = head[node]!; c >= 0; c = link[c]!) {
        if (!used[c]) {
          chain = c;
          break;
        }
      }
      const back = node === 0 ? stops - 1 : node - 1;
      const forward = cover[node]! > 0;
      const backward = cover[back]! < 0;
      // A chain ending on the outline goes on along it; a stretch of outline ends where the
      // next chain starts.
      if (chain >= 0 && (!byChain || (!forward && !backward))) {
        used[chain] = 1;
        const points = chains[chain]!;
        for (let i = 0; i < points.length; i++) polygon.push(points[i]!);
        node = target[chain]!;
        byChain = true;
      } else if (forward) {
        cover[node]!--;
        polygon.push(stopX[node]!, stopY[node]!);
        node = node + 1 === stops ? 0 : node + 1;
        polygon.push(stopX[node]!, stopY[node]!);
        byChain = false;
      } else if (backward) {
        cover[back]!++;
        polygon.push(stopX[node]!, stopY[node]!);
        node = back;
        polygon.push(stopX[node]!, stopY[node]!);
        byChain = false;
      } else {
        break;
      }
    }
    for (const node of trail) seen[node] = -1;
    trail.length = 0;
    sizes.length = 0;
    polygon.length = 0;
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

    // Position of a point of side `side` along the cell outline, counter-clockwise from the
    // south-west corner: [0, 1] bottom, [1, 2] right, [2, 3] top, [3, 4] left.
    const along = (side: number, x: number, y: number): number =>
      side === 0
        ? (x - x0) / width
        : side === 1
          ? 1 + (y - y0) / height
          : side === 2
            ? 2 + (x1 - x) / width
            : 3 + (y1 - y) / height;
    const sideAt = (x: number, y: number): number => (y === y0 ? 0 : x === x1 ? 1 : y === y1 ? 2 : 3);

    let net = 0;
    chains = [];
    chainFrom = [];
    chainTo = [];
    const loops: number[][] = [];
    // Bridges, as pairs of marks.
    const spans: number[] = [];
    markCount = 0;

    for (const ring of cellRings) {
      const m = ring.length / 2;
      /** Side of the cell the edge leaving point `i` runs along, or -1 for a real edge. */
      const sideOf = (i: number): number => {
        const j = i + 1 === m ? 0 : i + 1;
        const ax = ring[i * 2]!;
        const ay = ring[i * 2 + 1]!;
        if (ay === ring[j * 2 + 1]) {
          if (ay === y0) return 0;
          if (ay === y1) return 2;
        }
        if (ax === ring[j * 2]) {
          if (ax === x1) return 1;
          if (ax === x0) return 3;
        }
        return -1;
      };
      let firstBridge = -1;
      let bridges = 0;
      for (let i = 0; i < m; i++) {
        if (sideOf(i) >= 0) {
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
        net += Math.round(ringArea(ring) / cellArea);
        continue;
      }
      let current: number[] | null = null;
      for (let step = 1; step <= m; step++) {
        const i = (firstBridge + step) % m;
        const j = i + 1 === m ? 0 : i + 1;
        const side = sideOf(i);
        if (side >= 0) {
          if (current) chains.push(current);
          current = null;
          const ax = ring[i * 2]!;
          const ay = ring[i * 2 + 1]!;
          const bx = ring[j * 2]!;
          const by = ring[j * 2 + 1]!;
          spans.push(addMark(along(side, ax, ay), ax, ay), addMark(along(side, bx, by), bx, by));
          continue;
        }
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

    // The triangulator skips points lying exactly on the line between their neighbours. Drop
    // them here, so that the outline (which becomes walls) and the triangles agree on vertices.
    for (let i = 0; i < chains.length; i++) chains[i] = straighten(chains[i]!, false);
    for (let i = 0; i < loops.length; i++) loops[i] = straighten(loops[i]!, true);

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

    outers = [];
    // Outlines wound the wrong way, or with no area: slivers where the input pinches or
    // overlaps itself by a hair. They still have to be filled, to keep the surface closed.
    slivers = [];

    if (chains.length) {
      // The bridges tell how many times each stretch of the cell outline is covered: summed
      // up, they are the winding number just inside it. That is all it takes to close the
      // chains into polygons, and unlike the order of two crossings a hair apart it cannot
      // disagree between the two cells sharing a side.
      const count = chains.length;
      for (let i = 0; i < count; i++) {
        const chain = chains[i]!;
        const n = chain.length;
        const ax = chain[0]!;
        const ay = chain[1]!;
        const bx = chain[n - 2]!;
        const by = chain[n - 1]!;
        chainFrom.push(addMark(along(sideAt(ax, ay), ax, ay), ax, ay));
        chainTo.push(addMark(along(sideAt(bx, by), bx, by), bx, by));
      }
      addMark(0, x0, y0);
      addMark(1, x1, y0);
      addMark(2, x1, y1);
      addMark(3, x0, y1);

      // Sort the marks along the outline (there are few: insertion sort) and number the stops.
      for (let i = 0; i < markCount; i++) {
        const position = markAt[i]!;
        let k = i;
        for (; k > 0 && markAt[markOrder[k - 1]!]! > position; k--) markOrder[k] = markOrder[k - 1]!;
        markOrder[k] = i;
      }
      stops = 0;
      let previous = -1;
      for (let k = 0; k < markCount; k++) {
        const i = markOrder[k]!;
        const position = markAt[i]!;
        if (position === 4) {
          // The end of the left side is the south-west corner again.
          markNode[i] = 0;
          continue;
        }
        if (position !== previous) {
          stopX[stops] = markX[i]!;
          stopY[stops] = markY[i]!;
          previous = position;
          stops++;
        }
        markNode[i] = stops - 1;
      }

      // cover[k]: how many times the stretch from stop k to the next one is covered.
      cover.fill(net, 0, stops);
      for (let i = 0; i < spans.length; i += 2) {
        const from = spans[i]!;
        const to = spans[i + 1]!;
        const forward = markAt[to]! > markAt[from]!;
        const low = markNode[forward ? from : to]!;
        const high = forward ? to : from;
        const last = markAt[high] === 4 ? stops : markNode[high]!;
        for (let k = low; k < last; k++) cover[k]! += forward ? 1 : -1;
      }

      if (origin.length < count) {
        origin = new Int32Array(count * 2);
        target = new Int32Array(count * 2);
        link = new Int32Array(count * 2);
        used = new Uint8Array(count * 2);
      }
      head.fill(-1, 0, stops);
      seen.fill(-1, 0, stops);
      used.fill(0, 0, count);
      for (let i = 0; i < count; i++) {
        origin[i] = markNode[chainFrom[i]!]!;
        target[i] = markNode[chainTo[i]!]!;
        link[i] = head[origin[i]!]!;
        head[origin[i]!] = i;
      }

      for (let i = 0; i < count; i++) if (!used[i]) walk(origin[i]!);
      for (let k = 0; k < stops; k++) {
        for (let guard = Math.abs(cover[k]!); guard > 0 && cover[k] !== 0; guard--) {
          walk(cover[k]! > 0 ? k : k + 1 === stops ? 0 : k + 1);
        }
      }
    } else if (net > 0) {
      outers.push([x0, y0, x1, y0, x1, y1, x0, y1]);
    }

    const holes: number[][] = [];
    for (const loop of loops) {
      const area = ringArea(loop);
      if (area > 0) outers.push(loop);
      else if (area < 0) holes.push(loop);
    }

    for (const sliver of slivers) emitPolygon(sliver, [], Math.sign(ringArea(sliver)));
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
