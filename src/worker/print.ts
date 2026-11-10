import earcut from "earcut";
import { type LayerId, type PrintParams, type PrintPart, TREE_STRIDE } from "../core/types";
import type { BuildState } from "./build";
import {
  difference,
  FINE,
  inflatePolygons,
  intersect,
  type Paths64,
  regularize,
  toPath,
  toPolygons,
  toRings,
  union,
} from "./clip";
import type { Polygon, Ring } from "./poly";
import { straighten, type Tessellation, tessellate } from "./tessellate";

/** Triangle soup in printer space: x east, y north, z up, millimetres. */
class Soup {
  data: number[] = [];
  shells: number[] = [];

  /** Marks the start of a new closed shell. */
  shell(): void {
    const index = this.data.length / 9;
    if (this.shells[this.shells.length - 1] !== index) this.shells.push(index);
  }

  triangle(
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    cx: number,
    cy: number,
    cz: number,
  ): void {
    this.data.push(ax, ay, az, bx, by, bz, cx, cy, cz);
  }

  finish(): Float32Array {
    return new Float32Array(this.data);
  }
}

type Height = (x: number, y: number) => number;

/** Sheets drawn over others win the overlap, so that printed parts never share volume. */
const PRIORITY: LayerId[] = [
  "rail",
  "roads",
  "paths",
  "paved",
  "sport",
  "forest",
  "green",
  "sand",
  "rock",
  "ice",
  "farmland",
  "urban",
];

/** Typical feature width in metres, used to keep thin ribbons printable. */
const RIBBON_WIDTH: Partial<Record<LayerId, number>> = { roads: 6, paths: 2, rail: 2.6 };

/**
 * Rebuilds the model as closed solids for 3D printing.
 *
 * The terrain becomes a plate as deep as the water bed, with the land resting on it; every other
 * layer is a thin slab on top and every building a prism sunk slightly into the ground. Each
 * piece is a closed shell of its own and they all overlap or touch, so that a slicer fuses them
 * into a single object. Parts are returned separately to allow multi-colour prints.
 */
export function buildPrint(state: BuildState, params: PrintParams): { parts: PrintPart[]; scale: number } {
  const { terrain, ring, sheets } = state;
  const { area } = state.params;
  const scale = params.sizeMm / Math.max(area.width, area.depth);
  const vertical = scale * params.zScale;
  const feature = params.minFeatureMm;
  const wanted = new Set(params.layers);
  const floor = -params.baseMm;

  const top: Height = (x, y) => terrain.heightAt(x, y) * vertical;

  const surface = (soup: Soup, tess: Tessellation, z: Height, up: boolean): void => {
    const { xy, triangles } = tess;
    for (let i = 0; i < triangles.length; i += 3) {
      const a = triangles[i]! * 2;
      const b = triangles[up ? i + 1 : i + 2]! * 2;
      const c = triangles[up ? i + 2 : i + 1]! * 2;
      soup.triangle(
        xy[a]! * scale,
        xy[a + 1]! * scale,
        z(xy[a]!, xy[a + 1]!),
        xy[b]! * scale,
        xy[b + 1]! * scale,
        z(xy[b]!, xy[b + 1]!),
        xy[c]! * scale,
        xy[c + 1]! * scale,
        z(xy[c]!, xy[c + 1]!),
      );
    }
  };

  const walls = (soup: Soup, edges: number[], high: Height, low: Height): void => {
    for (let i = 0; i < edges.length; i += 4) {
      const ax = edges[i]!;
      const ay = edges[i + 1]!;
      const bx = edges[i + 2]!;
      const by = edges[i + 3]!;
      const aTop = high(ax, ay);
      const bTop = high(bx, by);
      const aLow = low(ax, ay);
      const bLow = low(bx, by);
      const x0 = ax * scale;
      const y0 = ay * scale;
      const x1 = bx * scale;
      const y1 = by * scale;
      soup.triangle(x0, y0, aTop, x0, y0, aLow, x1, y1, bLow);
      soup.triangle(x0, y0, aTop, x1, y1, bLow, x1, y1, bTop);
    }
  };

  /** Closed slab between two surfaces over the given outlines. */
  const slab = (soup: Soup, rings: Ring[], high: Height, low: Height): void => {
    if (!rings.length) return;
    soup.shell();
    const tess = tessellate(rings, terrain);
    surface(soup, tess, high, true);
    surface(soup, tess, low, false);
    walls(soup, tess.edges, high, low);
  };
  /** Outlines of clipped shapes, made fit to stand walls on. */
  const sound = (paths: Paths64): Ring[] => toRings(regularize(paths), FINE);

  const parts: PrintPart[] = [];
  const emit = (layer: LayerId, soup: Soup): void => {
    if (!soup.data.length) return;
    if (soup.shells[0] !== 0) soup.shells.unshift(0);
    parts.push({ layer, triangles: soup.finish(), shells: new Uint32Array(soup.shells) });
  };

  // ---- Terrain ------------------------------------------------------------------------------
  const plate = [toPath(ring)];
  const rim = [toPath(ring, FINE)];
  const wet = wanted.has("water") ? (sheets.water ?? []) : [];
  let shore: Paths64 = [];
  if (wet.length) {
    // Water reaching the rim is stretched past it first, so that it still does once its
    // outline has been regularized.
    const collar = difference(inflatePolygons(plate, 0.5), plate);
    shore = regularize(union([...wet, ...intersect(inflatePolygons(wet, 0.1), collar)]));
  }
  const water = toRings(intersect(shore, rim), FINE);
  const recess = water.length ? feature * 2 : 0;
  const bed: Height = (x, y) => top(x, y) - recess;

  const block = new Soup();
  slab(block, toRings(rim, FINE), bed, () => floor);
  if (water.length) {
    // The land stands on the plate, sunk into it by a hair so that the two become one.
    slab(block, toRings(difference(rim, shore), FINE), top, (x, y) => bed(x, y) - feature * 0.25);
  }
  emit("base", block);

  if (water.length) {
    // A thin fill, just below the banks, so that water can be printed in its own colour.
    const fill = new Soup();
    slab(fill, water, (x, y) => top(x, y) - feature * 0.5, bed);
    emit("water", fill);
  }

  // ---- Sheets -------------------------------------------------------------------------------
  let above: Paths64 = [];
  for (const layer of PRIORITY) {
    let paths = sheets[layer];
    if (!paths?.length || !wanted.has(layer)) continue;
    const typical = RIBBON_WIDTH[layer];
    if (typical !== undefined) {
      // Widen ribbons that would come out thinner than the nozzle can lay down.
      const grow = (Math.max(feature * 1.25, 0.5) / scale - typical) / 2;
      if (grow > 0.05) paths = intersect(inflatePolygons(paths, grow, true), plate);
    }
    const own = difference(paths, above);
    above = union([...above, ...paths]);
    const thickness = feature * (typical !== undefined ? 1.5 : 1);
    const soup = new Soup();
    const roof: Height = (x, y) => top(x, y) + thickness;
    slab(soup, sound(water.length ? difference(own, wet) : own), roof, top);
    // Bridges and piers go down to the water bed, so nothing is left hanging.
    if (water.length) slab(soup, sound(intersect(own, wet)), roof, bed);
    emit(layer, soup);
  }

  // ---- Buildings ----------------------------------------------------------------------------
  if (wanted.has("buildings")) {
    const soup = new Soup();
    const prism = (source: Polygon, low: number, high: number): void => {
      soup.shell();
      // Caps and walls must use the very same corners: see `straighten`.
      const polygon: Polygon = {
        outer: straighten(source.outer, true),
        holes: source.holes.map((hole) => straighten(hole, true)),
      };
      const coords = polygon.outer.slice();
      const holes: number[] = [];
      for (const hole of polygon.holes) {
        holes.push(coords.length / 2);
        for (let i = 0; i < hole.length; i++) coords.push(hole[i]!);
      }
      const indices = earcut(coords, holes.length ? holes : undefined);
      for (let i = 0; i < indices.length; i += 3) {
        let a = indices[i]! * 2;
        let b = indices[i + 1]! * 2;
        const c = indices[i + 2]! * 2;
        const cross =
          (coords[b]! - coords[a]!) * (coords[c + 1]! - coords[a + 1]!) -
          (coords[b + 1]! - coords[a + 1]!) * (coords[c]! - coords[a]!);
        if (cross === 0) continue;
        if (cross < 0) [a, b] = [b, a];
        soup.triangle(
          coords[a]! * scale,
          coords[a + 1]! * scale,
          high,
          coords[b]! * scale,
          coords[b + 1]! * scale,
          high,
          coords[c]! * scale,
          coords[c + 1]! * scale,
          high,
        );
        soup.triangle(
          coords[b]! * scale,
          coords[b + 1]! * scale,
          low,
          coords[a]! * scale,
          coords[a + 1]! * scale,
          low,
          coords[c]! * scale,
          coords[c + 1]! * scale,
          low,
        );
      }
      for (const edge of [polygon.outer, ...polygon.holes]) {
        const n = edge.length;
        for (let i = 0; i < n; i += 2) {
          const j = (i + 2) % n;
          const x0 = edge[i]! * scale;
          const y0 = edge[i + 1]! * scale;
          const x1 = edge[j]! * scale;
          const y1 = edge[j + 1]! * scale;
          soup.triangle(x0, y0, high, x0, y0, low, x1, y1, low);
          soup.triangle(x0, y0, high, x1, y1, low, x1, y1, high);
        }
      }
    };
    // A footprint touching itself at a corner (a courtyard reaching the outer wall, say) would
    // leave an edge shared by four walls: pull such outlines apart first.
    const corners = new Set<number>();
    const footprints = (polygon: Polygon): Polygon[] => {
      corners.clear();
      let count = 0;
      for (const edge of [polygon.outer, ...polygon.holes]) {
        for (let i = 0; i < edge.length; i += 2) {
          corners.add(Math.round(edge[i]! * 100) * 4194304 + Math.round(edge[i + 1]! * 100));
          count++;
        }
      }
      if (corners.size === count) return [polygon];
      return toPolygons(regularize([polygon.outer, ...polygon.holes].map((edge) => toPath(edge))), FINE);
    };
    for (const solid of state.solids) {
      const ground = solid.ground * vertical;
      // Printed buildings always reach the ground and keep a minimum height.
      const eaves = Math.max(solid.top * vertical, ground + feature * 1.5);
      for (const footprint of footprints(solid.polygon)) prism(footprint, ground - feature, eaves);
      // Each roof facet is a closed wedge standing on the eaves plane.
      for (const piece of solid.roof ?? []) {
        soup.shell();
        const { ring, z } = piece;
        const n = ring.length / 2;
        // Height of every corner. A rise of next to nothing is none at all: the faces meeting
        // at a corner must agree on where it is to the last bit.
        const rise: number[] = [];
        for (let i = 0; i < n; i++) {
          const lift = z[i]! * vertical;
          rise.push(lift > 1e-4 ? eaves + lift : eaves);
        }
        const indices = n === 3 ? [0, 1, 2] : earcut(ring);
        for (let i = 0; i < indices.length; i += 3) {
          let a = indices[i]!;
          let b = indices[i + 1]!;
          const c = indices[i + 2]!;
          const cross =
            (ring[b * 2]! - ring[a * 2]!) * (ring[c * 2 + 1]! - ring[a * 2 + 1]!) -
            (ring[b * 2 + 1]! - ring[a * 2 + 1]!) * (ring[c * 2]! - ring[a * 2]!);
          if (cross === 0) continue;
          // A facet lying flat on the eaves would only double the floor under it.
          if (rise[a] === eaves && rise[b] === eaves && rise[c] === eaves) continue;
          if (cross < 0) [a, b] = [b, a];
          const ax = ring[a * 2]! * scale;
          const ay = ring[a * 2 + 1]! * scale;
          const bx = ring[b * 2]! * scale;
          const by = ring[b * 2 + 1]! * scale;
          const cx = ring[c * 2]! * scale;
          const cy = ring[c * 2 + 1]! * scale;
          soup.triangle(ax, ay, rise[a]!, bx, by, rise[b]!, cx, cy, rise[c]!);
          soup.triangle(bx, by, eaves, ax, ay, eaves, cx, cy, eaves);
        }
        const winding = Math.sign(
          ring.reduce((sum, _, i) => {
            if (i % 2) return sum;
            const j = (i + 2) % ring.length;
            return sum + ring[i]! * ring[j + 1]! - ring[j]! * ring[i + 1]!;
          }, 0),
        );
        for (let i = 0; i < n; i++) {
          // Walk the ring counter-clockwise so that the sides face outwards.
          const from = winding >= 0 ? i : (n - i) % n;
          const to = winding >= 0 ? (i + 1) % n : (n - i - 1 + n) % n;
          const zFrom = rise[from]!;
          const zTo = rise[to]!;
          const x0 = ring[from * 2]! * scale;
          const y0 = ring[from * 2 + 1]! * scale;
          const x1 = ring[to * 2]! * scale;
          const y1 = ring[to * 2 + 1]! * scale;
          if (zFrom > eaves) soup.triangle(x0, y0, zFrom, x0, y0, eaves, x1, y1, eaves);
          if (zTo > eaves) soup.triangle(x0, y0, zFrom, x1, y1, eaves, x1, y1, zTo);
        }
      }
    }
    emit("buildings", soup);
  }

  // ---- Trees --------------------------------------------------------------------------------
  if (wanted.has("trees") && state.trees.count) {
    const soup = new Soup();
    const sides = 6;
    // One table for every cone: neighbouring faces must agree on their corners to the last bit.
    const circle = Array.from({ length: sides }, (_, s) => {
      const angle = (s / sides) * Math.PI * 2;
      return [Math.cos(angle), Math.sin(angle)] as const;
    });
    const { data, count } = state.trees;
    for (let i = 0; i < count; i++) {
      soup.shell();
      const o = i * TREE_STRIDE;
      const x = data[o]! * scale;
      const y = -data[o + 2]! * scale;
      const base = terrain.heightAt(data[o]!, -data[o + 2]!) * vertical - feature * 0.5;
      const tip = base + Math.max(data[o + 3]! * vertical, feature * 3);
      const radius = Math.max(data[o + 4]! * scale, feature * 0.9);
      for (let s = 0; s < sides; s++) {
        const from = circle[s]!;
        const to = circle[(s + 1) % sides]!;
        const x0 = x + from[0] * radius;
        const y0 = y + from[1] * radius;
        const x1 = x + to[0] * radius;
        const y1 = y + to[1] * radius;
        soup.triangle(x0, y0, base, x1, y1, base, x, y, tip);
        soup.triangle(x1, y1, base, x0, y0, base, x, y, base);
      }
    }
    emit("trees", soup);
  }

  return { parts, scale };
}
