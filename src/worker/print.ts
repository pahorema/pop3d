import earcut from "earcut";
import { type LayerId, type PrintParams, type PrintPart, TREE_STRIDE } from "../core/types";
import type { BuildState } from "./build";
import { difference, inflatePolygons, intersect, type Paths64, toPath, toRings, union } from "./clip";
import { distanceToRing, type Polygon } from "./poly";
import { type Tessellation, tessellate } from "./tessellate";

/** Triangle soup in printer space: x east, y north, z up, millimetres. */
class Soup {
  data: number[] = [];

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
  "farmland",
  "urban",
];

/** Typical feature width in metres, used to keep thin ribbons printable. */
const RIBBON_WIDTH: Partial<Record<LayerId, number>> = { roads: 6, paths: 2, rail: 2.6 };

/**
 * Rebuilds the model as closed solids for 3D printing.
 *
 * The terrain becomes one block with the water recessed into it; every other layer is a thin
 * slab resting on it and every building a prism sunk slightly into the ground, so that a slicer
 * fuses everything into a single object. Parts are returned separately to allow multi-colour
 * prints.
 */
export function buildPrint(state: BuildState, params: PrintParams): { parts: PrintPart[]; scale: number } {
  const { terrain, ring, sheets } = state;
  const { area } = state.params;
  const scale = params.sizeMm / Math.max(area.width, area.depth);
  const vertical = scale * params.zScale;
  const feature = params.minFeatureMm;
  const wanted = new Set(params.layers);
  const floor = -params.baseMm;
  const recess = wanted.has("water") ? feature * 2 : 0;

  const top: Height = (x, y) => terrain.heightAt(x, y) * vertical;
  const onOutline = (ax: number, ay: number, bx: number, by: number) =>
    distanceToRing((ax + bx) / 2, (ay + by) / 2, ring) < 0.03;

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

  const walls = (
    soup: Soup,
    edges: number[],
    high: Height,
    low: Height,
    filter?: (ax: number, ay: number, bx: number, by: number) => boolean,
  ): void => {
    for (let i = 0; i < edges.length; i += 4) {
      const ax = edges[i]!;
      const ay = edges[i + 1]!;
      const bx = edges[i + 2]!;
      const by = edges[i + 3]!;
      if (filter && !filter(ax, ay, bx, by)) continue;
      const aTop = high(ax, ay);
      const bTop = high(bx, by);
      const aLow = low(ax, ay);
      const bLow = low(bx, by);
      if (aTop - aLow < 1e-6 && bTop - bLow < 1e-6) continue;
      const x0 = ax * scale;
      const y0 = ay * scale;
      const x1 = bx * scale;
      const y1 = by * scale;
      soup.triangle(x0, y0, aTop, x0, y0, aLow, x1, y1, bLow);
      soup.triangle(x0, y0, aTop, x1, y1, bLow, x1, y1, bTop);
    }
  };

  /** Closed slab between two surfaces over the given outlines. */
  const slab = (soup: Soup, paths: Paths64, high: Height, low: Height): void => {
    const rings = toRings(paths);
    if (!rings.length) return;
    const tess = tessellate(rings, terrain);
    surface(soup, tess, high, true);
    surface(soup, tess, low, false);
    walls(soup, tess.edges, high, low);
  };

  const parts: PrintPart[] = [];
  const emit = (layer: LayerId, soup: Soup): void => {
    if (soup.data.length) parts.push({ layer, triangles: soup.finish() });
  };

  const water = wanted.has("water") ? (sheets.water ?? []) : [];
  const land = water.length ? (sheets.ground ?? []) : [toPath(ring)];

  // ---- Terrain block ------------------------------------------------------------------------
  const block = new Soup();
  const landTess = tessellate(toRings(land), terrain);
  surface(block, landTess, top, true);
  const bed: Height = (x, y) => top(x, y) - recess;
  const flat: Height = () => floor;
  // Rim walls are split at the level of the water bed, so that they meet the banks and the
  // rim under the water edge to edge wherever a shore reaches the outline.
  walls(block, landTess.edges, top, bed);
  walls(block, landTess.edges, bed, flat, onOutline);
  // The underside reuses the very same triangles as the top, so every seam lines up exactly.
  surface(block, landTess, flat, false);
  if (water.length) {
    const waterTess = tessellate(toRings(water), terrain);
    surface(block, waterTess, bed, true);
    walls(block, waterTess.edges, bed, flat, onOutline);
    surface(block, waterTess, flat, false);
  }
  emit("base", block);

  if (water.length) {
    // A thin fill, just below the banks, so that water can be printed in its own colour.
    const fill = new Soup();
    slab(
      fill,
      water,
      (x, y) => top(x, y) - feature * 0.5,
      (x, y) => top(x, y) - recess,
    );
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
      if (grow > 0.05) paths = intersect(inflatePolygons(paths, grow, true), [toPath(ring)]);
    }
    const own = difference(paths, above);
    above = union([...above, ...paths]);
    const thickness = feature * (typical !== undefined ? 1.5 : 1);
    const soup = new Soup();
    slab(soup, difference(own, water), (x, y) => top(x, y) + thickness, top);
    // Bridges and piers go down to the water bed, so nothing is left hanging.
    if (water.length) {
      slab(
        soup,
        intersect(own, water),
        (x, y) => top(x, y) + thickness,
        (x, y) => top(x, y) - recess,
      );
    }
    emit(layer, soup);
  }

  // ---- Buildings ----------------------------------------------------------------------------
  if (wanted.has("buildings")) {
    const soup = new Soup();
    const prism = (polygon: Polygon, low: number, high: number): void => {
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
    for (const solid of state.solids) {
      const ground = solid.ground * vertical;
      // Printed buildings always reach the ground and keep a minimum height.
      prism(solid.polygon, ground - feature, Math.max(solid.top * vertical, ground + feature * 1.5));
    }
    emit("buildings", soup);
  }

  // ---- Trees --------------------------------------------------------------------------------
  if (wanted.has("trees") && state.trees.count) {
    const soup = new Soup();
    const sides = 6;
    const { data, count } = state.trees;
    for (let i = 0; i < count; i++) {
      const o = i * TREE_STRIDE;
      const x = data[o]! * scale;
      const y = -data[o + 2]! * scale;
      const base = terrain.heightAt(data[o]!, -data[o + 2]!) * vertical - feature * 0.5;
      const tip = base + Math.max(data[o + 3]! * vertical, feature * 3);
      const radius = Math.max(data[o + 4]! * scale, feature * 0.9);
      for (let s = 0; s < sides; s++) {
        const a0 = (s / sides) * Math.PI * 2;
        const a1 = ((s + 1) / sides) * Math.PI * 2;
        const x0 = x + Math.cos(a0) * radius;
        const y0 = y + Math.sin(a0) * radius;
        const x1 = x + Math.cos(a1) * radius;
        const y1 = y + Math.sin(a1) * radius;
        soup.triangle(x0, y0, base, x1, y1, base, x, y, tip);
        soup.triangle(x1, y1, base, x0, y0, base, x, y, base);
      }
    }
    emit("trees", soup);
  }

  return { parts, scale };
}
