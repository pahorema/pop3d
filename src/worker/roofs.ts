import type { OsmTags } from "../../shared/types";
import { fromPath, intersect, toPath } from "./clip";
import { parseMeters } from "./features";
import { hash01, type Ring, ringArea, ringCentroid } from "./poly";

export type RoofShape = "gabled" | "hipped" | "pyramidal" | "skillion" | "dome";

/**
 * One planar (or, for domes, nearly planar) patch of roof: a ring in plan with the height of
 * every corner above the eaves. Patches never overlap and together cover the footprint.
 */
export interface RoofPiece {
  ring: number[];
  z: number[];
  /** Smooth normals as (east, north, up) triplets, for curved roofs. */
  normals?: number[];
}

/** Oriented bounding box of a footprint: `u` runs along its length, `v` across it. */
interface Frame {
  cx: number;
  cy: number;
  ux: number;
  uy: number;
  vx: number;
  vy: number;
  /** Half extent along `u`. */
  length: number;
  /** Half extent along `v`. */
  width: number;
}

const TAGGED: Record<string, RoofShape> = {
  gabled: "gabled",
  "half-hipped": "gabled",
  gambrel: "gabled",
  saltbox: "gabled",
  round: "gabled",
  hipped: "hipped",
  mansard: "hipped",
  pyramidal: "pyramidal",
  cone: "pyramidal",
  skillion: "skillion",
  lean_to: "skillion",
  dome: "dome",
  onion: "dome",
};

const HOUSE_LIKE =
  /^(house|detached|semidetached_house|terrace|bungalow|cabin|farm|chapel|church|barn|hut|residential|farm_auxiliary|stable|cowshed|garage|garages|shed)$/;

/** Smallest rectangle around the ring, trying the direction of every edge. */
function frameOf(ring: Ring): Frame {
  const n = ring.length;
  let best: Frame | null = null;
  let bestArea = Number.POSITIVE_INFINITY;
  for (let i = 0; i < n; i += 2) {
    const j = (i + 2) % n;
    let ux = ring[j]! - ring[i]!;
    let uy = ring[j + 1]! - ring[i + 1]!;
    const size = Math.hypot(ux, uy);
    if (size < 0.2) continue;
    ux /= size;
    uy /= size;
    let minU = Number.POSITIVE_INFINITY;
    let maxU = Number.NEGATIVE_INFINITY;
    let minV = Number.POSITIVE_INFINITY;
    let maxV = Number.NEGATIVE_INFINITY;
    for (let k = 0; k < n; k += 2) {
      const pu = ring[k]! * ux + ring[k + 1]! * uy;
      const pv = -ring[k]! * uy + ring[k + 1]! * ux;
      if (pu < minU) minU = pu;
      if (pu > maxU) maxU = pu;
      if (pv < minV) minV = pv;
      if (pv > maxV) maxV = pv;
    }
    const area = (maxU - minU) * (maxV - minV);
    if (area >= bestArea) continue;
    bestArea = area;
    const midU = (minU + maxU) / 2;
    const midV = (minV + maxV) / 2;
    best = {
      cx: midU * ux - midV * uy,
      cy: midU * uy + midV * ux,
      ux,
      uy,
      vx: -uy,
      vy: ux,
      length: (maxU - minU) / 2,
      width: (maxV - minV) / 2,
    };
  }
  if (!best) {
    const [cx, cy] = ringCentroid(ring);
    return { cx, cy, ux: 1, uy: 0, vx: 0, vy: 1, length: 1, width: 1 };
  }
  if (best.width > best.length) {
    // Keep `u` as the long side.
    best = {
      ...best,
      ux: best.vx,
      uy: best.vy,
      vx: -best.ux,
      vy: -best.uy,
      length: best.width,
      width: best.length,
    };
  }
  return best;
}

/**
 * Decides whether a building gets a pitched roof and how tall it is: what OSM says wins,
 * otherwise small, compact, house-like footprints get a plausible one.
 */
export function chooseRoof(
  tags: OsmTags,
  kind: string,
  outer: Ring,
  area: number,
  height: number,
  id: number,
): { shape: RoofShape; height: number } | null {
  const frame = frameOf(outer);
  const tagged = tags["roof:shape"];
  let shape: RoofShape;
  if (tagged) {
    const known = TAGGED[tagged];
    if (!known) return null;
    shape = known;
  } else {
    const anonymous = kind === "yes" && area < 240;
    if (!anonymous && !HOUSE_LIKE.test(kind)) return null;
    if (area < 18 || area > (kind === "church" ? 3000 : 650)) return null;
    // Sprawling or L-shaped footprints would get an implausible single ridge.
    if (area / (4 * frame.length * frame.width) < 0.72) return null;
    if (height > 16 && kind !== "church") return null;
    shape = hash01(id, 5) < 0.28 && frame.length / frame.width < 1.7 ? "hipped" : "gabled";
  }
  const span = shape === "dome" ? frame.width : frame.width;
  let roofHeight = parseMeters(tags["roof:height"]);
  if (roofHeight === undefined) {
    const levels = Number.parseFloat(tags["roof:levels"] ?? "");
    if (Number.isFinite(levels) && levels > 0) roofHeight = levels * 2.8;
    else if (shape === "dome") roofHeight = span;
    else if (shape === "pyramidal") roofHeight = span * 1.1;
    else if (shape === "skillion") roofHeight = span * 0.45;
    else roofHeight = span * (0.58 + 0.14 * hash01(id, 9));
  }
  roofHeight = Math.min(roofHeight, height * (tagged ? 0.75 : 0.48), tagged ? 80 : 6);
  if (roofHeight < 0.6) return null;
  return { shape, height: roofHeight };
}

/**
 * Cuts a footprint into the facets of the requested roof.
 * Returns `null` when the shape cannot be built on it, in which case the roof stays flat.
 */
export function roofPieces(outer: Ring, shape: RoofShape, height: number, tags: OsmTags): RoofPiece[] | null {
  if (outer.length < 6) return null;
  const [mx, my] = ringCentroid(outer);

  if (shape === "pyramidal" || shape === "dome") {
    const pieces: RoofPiece[] = [];
    const n = outer.length;
    const steps = shape === "dome" ? 6 : 1;
    for (let k = 0; k < steps; k++) {
      const t0 = k / steps;
      const t1 = (k + 1) / steps;
      // Domes follow a quarter of an ellipse; pyramids go straight to the apex.
      const s0 = shape === "dome" ? Math.cos((t0 * Math.PI) / 2) : 1;
      const s1 = shape === "dome" ? Math.cos((t1 * Math.PI) / 2) : 0;
      const z0 = shape === "dome" ? Math.sin((t0 * Math.PI) / 2) * height : 0;
      const z1 = shape === "dome" ? Math.sin((t1 * Math.PI) / 2) * height : height;
      for (let i = 0; i < n; i += 2) {
        const j = (i + 2) % n;
        const ax = outer[i]! - mx;
        const ay = outer[i + 1]! - my;
        const bx = outer[j]! - mx;
        const by = outer[j + 1]! - my;
        const ring = [mx + ax * s0, my + ay * s0, mx + bx * s0, my + by * s0];
        const z = [z0, z0];
        const corners: [number, number, number][] = [
          [ax, ay, t0],
          [bx, by, t0],
        ];
        if (s1 > 1e-6) {
          ring.push(mx + bx * s1, my + by * s1, mx + ax * s1, my + ay * s1);
          z.push(z1, z1);
          corners.push([bx, by, t1], [ax, ay, t1]);
        } else {
          ring.push(mx, my);
          z.push(z1);
          corners.push([(ax + bx) / 2, (ay + by) / 2, t1]);
        }
        const piece: RoofPiece = { ring, z };
        if (shape === "dome") {
          piece.normals = [];
          for (const [dx, dy, t] of corners) {
            const radius = Math.hypot(dx, dy) || 1;
            const angle = (t * Math.PI) / 2;
            const horizontal = Math.cos(angle) / radius;
            const up = Math.sin(angle) / Math.max(height, 0.1);
            const size = Math.hypot(horizontal, up) || 1;
            piece.normals.push(
              ((dx / radius) * horizontal) / size,
              ((dy / radius) * horizontal) / size,
              up / size,
            );
          }
        }
        pieces.push(piece);
      }
    }
    return pieces;
  }

  let frame = frameOf(outer);
  if (tags["roof:orientation"] === "across") {
    frame = {
      ...frame,
      ux: frame.vx,
      uy: frame.vy,
      vx: -frame.ux,
      vy: -frame.uy,
      length: frame.width,
      width: frame.length,
    };
  }
  const { cx, cy, ux, uy, vx, vy, length, width } = frame;
  if (width < 0.5) return null;
  const world = (a: number, b: number): [number, number] => [cx + a * ux + b * vx, cy + a * uy + b * vy];
  const local = (x: number, y: number): [number, number] => [
    (x - cx) * ux + (y - cy) * uy,
    (x - cx) * vx + (y - cy) * vy,
  ];

  if (shape === "skillion") {
    const bearing = Number.parseFloat(tags["roof:direction"] ?? "");
    const z: number[] = [];
    if (Number.isFinite(bearing)) {
      // The tagged direction is where the roof slopes down to.
      const dx = Math.sin((bearing * Math.PI) / 180);
      const dy = Math.cos((bearing * Math.PI) / 180);
      let min = Number.POSITIVE_INFINITY;
      let max = Number.NEGATIVE_INFINITY;
      for (let i = 0; i < outer.length; i += 2) {
        const along = outer[i]! * dx + outer[i + 1]! * dy;
        min = Math.min(min, along);
        max = Math.max(max, along);
      }
      for (let i = 0; i < outer.length; i += 2) {
        z.push(height * (1 - (outer[i]! * dx + outer[i + 1]! * dy - min) / Math.max(max - min, 0.01)));
      }
    } else {
      for (let i = 0; i < outer.length; i += 2) {
        const [, b] = local(outer[i]!, outer[i + 1]!);
        z.push(height * Math.min(1, Math.max(0, (b + width) / (2 * width))));
      }
    }
    return [{ ring: outer.slice(), z }];
  }

  // Gabled and hipped roofs: cut the footprint by the regions of an ideal roof on its bounding box.
  const margin = 2;
  const far = length + margin;
  const regions: { ring: [number, number][]; z: (a: number, b: number) => number }[] = [];
  const side = (_a: number, b: number) => height * (1 - Math.abs(b) / width);
  const ridge = length - width;
  if (shape === "gabled" || ridge < 0.4) {
    if (shape === "hipped") return roofPieces(outer, "pyramidal", height, tags);
    regions.push(
      {
        ring: [
          [-far, 0],
          [far, 0],
          [far, width + margin],
          [-far, width + margin],
        ],
        z: side,
      },
      {
        ring: [
          [-far, -width - margin],
          [far, -width - margin],
          [far, 0],
          [-far, 0],
        ],
        z: side,
      },
    );
  } else {
    const end = (a: number) => (height * (length - Math.abs(a))) / width;
    const out = width + margin;
    regions.push(
      {
        ring: [
          [-ridge, 0],
          [ridge, 0],
          [ridge + out, out],
          [-ridge - out, out],
        ],
        z: side,
      },
      {
        ring: [
          [-ridge - out, -out],
          [ridge + out, -out],
          [ridge, 0],
          [-ridge, 0],
        ],
        z: side,
      },
      {
        ring: [
          [ridge, 0],
          [ridge + out, -out],
          [ridge + out, out],
        ],
        z: end,
      },
      {
        ring: [
          [-ridge, 0],
          [-ridge - out, out],
          [-ridge - out, -out],
        ],
        z: end,
      },
    );
  }

  const footprint = [toPath(outer)];
  const pieces: RoofPiece[] = [];
  let covered = 0;
  for (const region of regions) {
    const clip = [toPath(region.ring.flatMap(([a, b]) => world(a, b)))];
    for (const path of intersect(footprint, clip)) {
      const ring = fromPath(path);
      const area = ringArea(ring);
      if (area < 0.05) continue;
      covered += area;
      const z: number[] = [];
      for (let i = 0; i < ring.length; i += 2) {
        const [a, b] = local(ring[i]!, ring[i + 1]!);
        z.push(Math.min(height, Math.max(0, region.z(a, b))));
      }
      pieces.push({ ring, z });
    }
  }
  // If the pieces do not add up to the footprint, something degenerate happened: stay flat.
  if (Math.abs(covered - Math.abs(ringArea(outer))) > Math.max(0.5, covered * 0.02)) return null;
  return pieces;
}
