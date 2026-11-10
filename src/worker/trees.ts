import { TREE_STRIDE, type TreesData } from "../core/types";
import { type Paths64, toRings } from "./clip";
import type { TreeFeature } from "./features";
import type { Heightfield } from "./heightfield";
import { pointInRing, type Ring, ringBox, rng } from "./poly";

/** A region to fill with scattered trees. */
export interface TreeZone {
  paths: Paths64;
  /** Average distance between neighbouring trees, in metres. */
  spacing: number;
  minHeight: number;
  maxHeight: number;
  /** Share of conifers, 0 to 1. */
  conifers: number;
  /** 0 plants a regular grid (orchards), 1 a fully irregular scatter. */
  jitter: number;
}

/** Even-odd scanline fill of rings into a coarse occupancy mask sampled at cell centres. */
function rasterMask(
  rings: Ring[],
  minX: number,
  minY: number,
  cell: number,
  cols: number,
  rows: number,
): Uint8Array {
  const mask = new Uint8Array(cols * rows);
  const crossings: number[] = [];
  for (let row = 0; row < rows; row++) {
    const y = minY + (row + 0.5) * cell;
    crossings.length = 0;
    for (const ring of rings) {
      const n = ring.length;
      for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
        const yi = ring[i + 1]!;
        const yj = ring[j + 1]!;
        if (yi > y !== yj > y) crossings.push(ring[i]! + ((y - yi) / (yj - yi)) * (ring[j]! - ring[i]!));
      }
    }
    if (crossings.length < 2) continue;
    crossings.sort((a, b) => a - b);
    for (let k = 0; k + 1 < crossings.length; k += 2) {
      const from = Math.max(0, Math.ceil((crossings[k]! - minX) / cell - 0.5));
      const to = Math.min(cols - 1, Math.floor((crossings[k + 1]! - minX) / cell - 0.5));
      for (let col = from; col <= to; col++) mask[row * cols + col] = 1;
    }
  }
  return mask;
}

interface Planted {
  x: number;
  y: number;
  height: number;
  conifer: boolean;
  seed: number;
}

function scatter(zone: TreeZone, random: () => number, out: Planted[]): void {
  const rings = toRings(zone.paths);
  if (!rings.length) return;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const ring of rings) {
    const box = ringBox(ring);
    minX = Math.min(minX, box.minX);
    minY = Math.min(minY, box.minY);
    maxX = Math.max(maxX, box.maxX);
    maxY = Math.max(maxY, box.maxY);
  }
  const cell = Math.max(1.2, zone.spacing / 3);
  const cols = Math.ceil((maxX - minX) / cell) + 1;
  const rows = Math.ceil((maxY - minY) / cell) + 1;
  if (cols * rows > 16_000_000) return;
  const mask = rasterMask(rings, minX, minY, cell, cols, rows);

  const stepX = zone.spacing;
  const stepY = zone.spacing * (zone.jitter > 0 ? 0.866 : 1);
  const wobble = zone.jitter * 0.42 * zone.spacing;
  let row = 0;
  for (let y = minY + stepY / 2; y < maxY; y += stepY, row++) {
    // Offset every other row: a hexagonal packing reads as natural once jittered.
    const shift = zone.jitter > 0 && row % 2 ? stepX / 2 : 0;
    for (let x = minX + stepX / 2 + shift; x < maxX; x += stepX) {
      const px = x + (random() * 2 - 1) * wobble;
      const py = y + (random() * 2 - 1) * wobble;
      const col = Math.floor((px - minX) / cell);
      const r = Math.floor((py - minY) / cell);
      const seed = random();
      const tall = random();
      const conifer = random() < zone.conifers;
      if (col < 0 || r < 0 || col >= cols || r >= rows || !mask[r * cols + col]) continue;
      out.push({
        x: px,
        y: py,
        height: zone.minHeight + (zone.maxHeight - zone.minHeight) * tall,
        conifer,
        seed,
      });
    }
  }
}

/**
 * Places every tree of the diorama: the ones mapped individually in OSM, rows of trees along
 * avenues, and a procedural scatter filling woods, parks and orchards.
 */
export function plantTrees(options: {
  mapped: TreeFeature[];
  rows: { line: Ring; conifer: boolean }[];
  zones: TreeZone[];
  terrain: Heightfield;
  /** Trees must fall inside this ring (the diorama outline, slightly shrunk). */
  bounds: Ring;
  lift: number;
  limit: number;
  seed: number;
}): TreesData {
  const { terrain, bounds } = options;
  const random = rng(options.seed);
  const mapped: Planted[] = [];
  const scattered: Planted[] = [];

  for (const tree of options.mapped) {
    mapped.push({ x: tree.x, y: tree.y, height: 6 + random() * 5.5, conifer: tree.conifer, seed: random() });
  }
  for (const { line, conifer } of options.rows) {
    let carried = 4;
    for (let i = 0; i + 3 < line.length; i += 2) {
      const ax = line[i]!;
      const ay = line[i + 1]!;
      const dx = line[i + 2]! - ax;
      const dy = line[i + 3]! - ay;
      const length = Math.hypot(dx, dy);
      let at = carried;
      for (; at < length; at += 8.5) {
        mapped.push({
          x: ax + (dx * at) / length,
          y: ay + (dy * at) / length,
          height: 7 + random() * 4,
          conifer,
          seed: random(),
        });
      }
      carried = at - length;
    }
  }
  for (const zone of options.zones) scatter(zone, random, scattered);

  // Too many trees: thin out the procedural ones evenly, never the mapped ones.
  const budget = Math.max(0, options.limit - mapped.length);
  const keep = scattered.length > budget ? budget / scattered.length : 1;
  const all = mapped.concat(keep < 1 ? scattered.filter(() => random() < keep) : scattered);

  const data = new Float32Array(all.length * TREE_STRIDE);
  const kinds = new Uint8Array(all.length);
  let count = 0;
  for (const tree of all) {
    if (!pointInRing(tree.x, tree.y, bounds)) continue;
    const o = count * TREE_STRIDE;
    data[o] = tree.x;
    data[o + 1] = terrain.heightAt(tree.x, tree.y) + options.lift;
    data[o + 2] = -tree.y;
    data[o + 3] = tree.height;
    data[o + 4] = tree.height * (tree.conifer ? 0.2 : 0.3) * (0.85 + tree.seed * 0.3);
    data[o + 5] = tree.seed;
    kinds[count] = tree.conifer ? 1 : 0;
    count++;
  }
  return { count, data: data.slice(0, count * TREE_STRIDE), kinds: kinds.slice(0, count) };
}
