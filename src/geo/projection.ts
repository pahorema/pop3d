import type { Area, ShapeKind } from "../core/types";

const EARTH_RADIUS = 6_378_137;
const RAD = Math.PI / 180;

export interface Projection {
  /** Geographic degrees to local metres: x grows east, y grows north. */
  toLocal(lat: number, lon: number): [number, number];
  toGeo(x: number, y: number): [number, number];
}

/** Local tangent-plane projection around a point; accurate to centimetres over a few kilometres. */
export function projector(lat0: number, lon0: number): Projection {
  const metersPerLat = RAD * EARTH_RADIUS;
  const metersPerLon = metersPerLat * Math.cos(lat0 * RAD);
  return {
    toLocal: (lat, lon) => [(lon - lon0) * metersPerLon, (lat - lat0) * metersPerLat],
    toGeo: (x, y) => [lat0 + y / metersPerLat, lon0 + x / metersPerLon],
  };
}

export interface GeoBounds {
  s: number;
  w: number;
  n: number;
  e: number;
}

/** Geographic bounding box of an area, grown by `margin` metres on every side. */
export function areaBounds(area: Area, margin = 0): GeoBounds {
  const { toGeo } = projector(area.lat, area.lon);
  const [s, w] = toGeo(-area.width / 2 - margin, -area.depth / 2 - margin);
  const [n, e] = toGeo(area.width / 2 + margin, area.depth / 2 + margin);
  return { s, w, n, e };
}

/**
 * Outline of the diorama as a flat `[x, y, x, y, ...]` ring in local metres,
 * counter-clockwise and centred on the origin.
 */
export function shapeRing(shape: ShapeKind, width: number, depth: number): number[] {
  const rx = width / 2;
  const ry = depth / 2;
  const ring: number[] = [];
  switch (shape) {
    case "circle": {
      const steps = 160;
      for (let i = 0; i < steps; i++) {
        const a = (i / steps) * Math.PI * 2;
        ring.push(Math.cos(a) * rx, Math.sin(a) * ry);
      }
      break;
    }
    case "hexagon": {
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        ring.push(Math.cos(a) * rx, (Math.sin(a) * ry) / Math.sin(Math.PI / 3));
      }
      break;
    }
    case "rounded": {
      const radius = Math.min(rx, ry) * 0.3;
      const steps = 14;
      const corners: [number, number, number][] = [
        [rx - radius, ry - radius, 0],
        [-rx + radius, ry - radius, 90],
        [-rx + radius, -ry + radius, 180],
        [rx - radius, -ry + radius, 270],
      ];
      for (const [cx, cy, start] of corners) {
        for (let i = 0; i <= steps; i++) {
          const a = (start + (i / steps) * 90) * RAD;
          ring.push(cx + Math.cos(a) * radius, cy + Math.sin(a) * radius);
        }
      }
      break;
    }
    default:
      ring.push(-rx, -ry, rx, -ry, rx, ry, -rx, ry);
  }
  return ring;
}

/** Ground area of the outline in square metres. */
export function shapeArea(shape: ShapeKind, width: number, depth: number): number {
  const ring = shapeRing(shape, width, depth);
  let sum = 0;
  for (let i = 0, n = ring.length; i < n; i += 2) {
    const j = (i + 2) % n;
    sum += ring[i]! * ring[j + 1]! - ring[j]! * ring[i + 1]!;
  }
  return Math.abs(sum) / 2;
}
