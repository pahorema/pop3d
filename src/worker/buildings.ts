import earcut from "earcut";
import type { OsmTags } from "../../shared/types";
import type { BuildingInfo, BuildingsData, Detail } from "../core/types";
import { intersect, normalize, type Paths64, toPath, toPolygons } from "./clip";
import { type BuildingFeature, parseMeters } from "./features";
import type { Heightfield } from "./heightfield";
import {
  type Box,
  boxesOverlap,
  hash01,
  type Polygon,
  pointInPolygon,
  pointInRing,
  polygonArea,
  type Ring,
  ringArea,
  ringBox,
  ringCentroid,
} from "./poly";

const LEVEL_HEIGHT = 3.1;

/** Typical heights in metres for buildings that carry no height information. */
const DEFAULT_HEIGHTS: Record<string, number> = {
  house: 6.5,
  detached: 6.5,
  semidetached_house: 6.5,
  terrace: 7,
  bungalow: 4,
  cabin: 3.5,
  farm: 7,
  residential: 10,
  apartments: 15,
  dormitory: 13,
  hotel: 16,
  commercial: 11,
  office: 18,
  retail: 6.5,
  supermarket: 6.5,
  industrial: 9,
  warehouse: 9,
  hangar: 11,
  barn: 7,
  farm_auxiliary: 5,
  stable: 5,
  greenhouse: 3.5,
  garage: 3,
  garages: 3,
  carport: 2.8,
  shed: 2.8,
  hut: 3,
  kiosk: 3,
  roof: 4,
  service: 3,
  toilets: 3,
  school: 11,
  university: 15,
  college: 13,
  hospital: 18,
  civic: 12,
  public: 12,
  government: 14,
  church: 14,
  chapel: 8,
  cathedral: 28,
  mosque: 13,
  temple: 12,
  synagogue: 12,
  monastery: 12,
  castle: 16,
  tower: 28,
  train_station: 12,
  transportation: 9,
  stadium: 18,
  grandstand: 12,
  sports_hall: 10,
  parking: 12,
  bridge: 5,
  ruins: 4,
  construction: 9,
};

interface Dimensions {
  height: number;
  minHeight: number;
  levels?: number;
  measured: boolean;
}

function dimensions(tags: OsmTags, id: number, footprint: number): Dimensions {
  const kind = tags.building && tags.building !== "yes" ? tags.building : (tags["building:part"] ?? "yes");
  const levels = Number.parseFloat(tags["building:levels"] ?? "");
  const minLevel = Number.parseFloat(tags["building:min_level"] ?? "");
  let minHeight = parseMeters(tags.min_height) ?? (Number.isFinite(minLevel) ? minLevel * LEVEL_HEIGHT : 0);
  let height = parseMeters(tags.height);
  let measured = true;
  if (height === undefined) {
    if (Number.isFinite(levels) && levels > 0) {
      const roofLevels = Number.parseFloat(tags["roof:levels"] ?? "");
      height = (levels + (Number.isFinite(roofLevels) ? roofLevels : 0)) * LEVEL_HEIGHT + 0.6;
    } else {
      measured = false;
      const typical = DEFAULT_HEIGHTS[kind];
      if (typical !== undefined) {
        height = typical * (0.9 + 0.25 * hash01(id));
      } else if (footprint < 35) {
        height = 3;
      } else {
        // Anonymous buildings: vary them by whole storeys so that blocks do not look extruded flat.
        const storeys = footprint < 140 ? 2 : 2 + Math.floor(hash01(id) * 3.2);
        height = storeys * LEVEL_HEIGHT + 0.6;
      }
    }
  }
  if (kind === "roof" && minHeight === 0 && !tags.height) minHeight = height - 0.5;
  height = Math.min(900, Math.max(2, height));
  minHeight = Math.min(Math.max(0, minHeight), height - 0.4);
  return { height, minHeight, levels: Number.isFinite(levels) ? levels : undefined, measured };
}

interface Prepared {
  feature: BuildingFeature;
  polygons: Polygon[];
  area: number;
  box: Box;
  centre: [number, number];
}

function prepare(feature: BuildingFeature): Prepared | null {
  let polygons: Polygon[];
  if (feature.rings.length === 1) {
    const ring = feature.rings[0]!;
    if (ring.length < 6) return null;
    const area = ringArea(ring);
    if (Math.abs(area) < 1) return null;
    let outer = ring;
    if (area < 0) {
      outer = [];
      for (let i = ring.length - 2; i >= 0; i -= 2) outer.push(ring[i]!, ring[i + 1]!);
    }
    polygons = [{ outer, holes: [] }];
  } else {
    polygons = toPolygons(normalize(feature.rings));
  }
  if (!polygons.length) return null;
  let area = 0;
  let largest = polygons[0]!;
  const box: Box = {
    minX: Number.POSITIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY,
  };
  for (const polygon of polygons) {
    const a = polygonArea(polygon);
    area += a;
    if (a > polygonArea(largest)) largest = polygon;
    const b = ringBox(polygon.outer);
    box.minX = Math.min(box.minX, b.minX);
    box.minY = Math.min(box.minY, b.minY);
    box.maxX = Math.max(box.maxX, b.maxX);
    box.maxY = Math.max(box.maxY, b.maxY);
  }
  if (area < 1) return null;
  return { feature, polygons, area, box, centre: ringCentroid(largest.outer) };
}

/**
 * Drops building outlines that are fully described by 3D parts mapped inside them, so the
 * detailed model replaces the plain extrusion instead of being buried in it.
 */
function resolveParts(items: Prepared[]): Prepared[] {
  const parts = items.filter((item) => item.feature.part);
  if (!parts.length) return items;
  const cell = 60;
  const index = new Map<string, Prepared[]>();
  for (const part of parts) {
    const key = `${Math.floor(part.centre[0] / cell)},${Math.floor(part.centre[1] / cell)}`;
    const bucket = index.get(key);
    if (bucket) bucket.push(part);
    else index.set(key, [part]);
  }
  return items.filter((item) => {
    if (item.feature.part) return true;
    let covered = 0;
    for (let gx = Math.floor(item.box.minX / cell); gx <= Math.floor(item.box.maxX / cell); gx++) {
      for (let gy = Math.floor(item.box.minY / cell); gy <= Math.floor(item.box.maxY / cell); gy++) {
        for (const part of index.get(`${gx},${gy}`) ?? []) {
          if (item.polygons.some((polygon) => pointInPolygon(part.centre[0], part.centre[1], polygon))) {
            covered += part.area;
          }
        }
      }
    }
    return covered < item.area * 0.7;
  });
}

const SMOOTH_COS = Math.cos((32 * Math.PI) / 180);
const EDGE_COS = Math.cos((28 * Math.PI) / 180);

export interface BuildingsResult {
  data: BuildingsData;
  /** Footprints of everything that was built, for keeping trees off the roofs. */
  footprints: Paths64;
  /** Kept for the 3D-print export. */
  solids: BuildingSolid[];
}

export interface BuildingSolid {
  polygon: Polygon;
  bottom: number;
  top: number;
  ground: number;
}

/** Extrudes every building footprint into walls and a flat roof standing on the terrain. */
export function buildBuildings(
  features: BuildingFeature[],
  terrain: Heightfield,
  shape: { ring: Ring; path: Paths64; box: Box },
  detail: Detail,
  walls: { layer: Paths64; height: number }[] = [],
): BuildingsResult {
  let items: Prepared[] = [];
  for (const feature of features) {
    if (feature.part && detail === 0) continue;
    const prepared = prepare(feature);
    if (prepared && boxesOverlap(prepared.box, shape.box)) items.push(prepared);
  }
  if (detail > 0) items = resolveParts(items);

  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const part: number[] = [];
  const base: number[] = [];
  const owner: number[] = [];
  const ranges: number[] = [];
  const anchors: number[] = [];
  const edges: number[] = [];
  const info: BuildingInfo[] = [];
  const footprints: Paths64 = [];
  const solids: BuildingSolid[] = [];

  const push = (
    x: number,
    y: number,
    z: number,
    nx: number,
    ny: number,
    nz: number,
    kind: number,
    ground: number,
  ) => {
    positions.push(x, y, z);
    normals.push(nx, ny, nz);
    part.push(kind);
    base.push(ground);
    owner.push(info.length);
    return positions.length / 3 - 1;
  };

  const extrude = (
    polygon: Polygon,
    bottom: number,
    top: number,
    ground: number,
    floating: boolean,
  ): void => {
    solids.push({ polygon, bottom, top, ground });
    for (const ring of [polygon.outer, ...polygon.holes]) {
      const n = ring.length / 2;
      // Outward normal of every edge (surface is on the left of the ring direction).
      const ex = new Float64Array(n);
      const ey = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const dx = ring[j * 2]! - ring[i * 2]!;
        const dy = ring[j * 2 + 1]! - ring[i * 2 + 1]!;
        const length = Math.hypot(dx, dy) || 1;
        ex[i] = dy / length;
        ey[i] = -dx / length;
      }
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const h = (i + n - 1) % n;
        const ax = ring[i * 2]!;
        const ay = ring[i * 2 + 1]!;
        const bx = ring[j * 2]!;
        const by = ring[j * 2 + 1]!;
        if (ax === bx && ay === by) continue;
        // Gentle corners (round towers, curved facades) share a normal and shade smoothly.
        let nax = ex[i]!;
        let nay = ey[i]!;
        const sharpStart = ex[h]! * ex[i]! + ey[h]! * ey[i]! < SMOOTH_COS;
        if (!sharpStart) {
          nax += ex[h]!;
          nay += ey[h]!;
          const l = Math.hypot(nax, nay) || 1;
          nax /= l;
          nay /= l;
        }
        let nbx = ex[i]!;
        let nby = ey[i]!;
        if (ex[i]! * ex[j]! + ey[i]! * ey[j]! >= SMOOTH_COS) {
          nbx += ex[j]!;
          nby += ey[j]!;
          const l = Math.hypot(nbx, nby) || 1;
          nbx /= l;
          nby /= l;
        }
        const v = push(ax, top, -ay, nax, 0, -nay, 0, ground);
        push(ax, bottom, -ay, nax, 0, -nay, 0, ground);
        push(bx, bottom, -by, nbx, 0, -nby, 0, ground);
        push(bx, top, -by, nbx, 0, -nby, 0, ground);
        indices.push(v, v + 1, v + 2, v, v + 2, v + 3);

        edges.push(ax, top, -ay, bx, top, -by);
        if (ex[h]! * ex[i]! + ey[h]! * ey[i]! < EDGE_COS) edges.push(ax, top, -ay, ax, bottom, -ay);
      }
    }

    const coords = polygon.outer.slice();
    const holeIndices: number[] = [];
    for (const hole of polygon.holes) {
      holeIndices.push(coords.length / 2);
      for (let i = 0; i < hole.length; i++) coords.push(hole[i]!);
    }
    const triangles = earcut(coords, holeIndices.length ? holeIndices : undefined);
    const first = positions.length / 3;
    for (let i = 0; i < coords.length; i += 2) push(coords[i]!, top, -coords[i + 1]!, 0, 1, 0, 1, ground);
    for (let i = 0; i < triangles.length; i += 3) {
      const a = triangles[i]!;
      const b = triangles[i + 1]!;
      const c = triangles[i + 2]!;
      const cross =
        (coords[b * 2]! - coords[a * 2]!) * (coords[c * 2 + 1]! - coords[a * 2 + 1]!) -
        (coords[b * 2 + 1]! - coords[a * 2 + 1]!) * (coords[c * 2]! - coords[a * 2]!);
      if (cross > 0) indices.push(first + a, first + b, first + c);
      else indices.push(first + a, first + c, first + b);
    }
    if (floating) {
      // Parts that start above the ground (passages, canopies) need an underside.
      const under = positions.length / 3;
      for (let i = 0; i < coords.length; i += 2)
        push(coords[i]!, bottom, -coords[i + 1]!, 0, -1, 0, 0, ground);
      for (let i = 0; i < triangles.length; i += 3) {
        const a = triangles[i]!;
        const b = triangles[i + 1]!;
        const c = triangles[i + 2]!;
        const cross =
          (coords[b * 2]! - coords[a * 2]!) * (coords[c * 2 + 1]! - coords[a * 2 + 1]!) -
          (coords[b * 2 + 1]! - coords[a * 2 + 1]!) * (coords[c * 2]! - coords[a * 2]!);
        if (cross > 0) indices.push(under + a, under + c, under + b);
        else indices.push(under + a, under + b, under + c);
      }
    }
  };

  const insideShape = (box: Box): boolean =>
    pointInRing(box.minX, box.minY, shape.ring) &&
    pointInRing(box.maxX, box.minY, shape.ring) &&
    pointInRing(box.maxX, box.maxY, shape.ring) &&
    pointInRing(box.minX, box.maxY, shape.ring);

  const emit = (
    polygons: Polygon[],
    box: Box,
    record: BuildingInfo,
    height: number,
    minHeight: number,
  ): void => {
    let kept = polygons;
    if (!insideShape(box)) {
      // Buildings on the rim are sliced cleanly, like the rest of the model.
      const paths = polygons.flatMap((polygon) => [polygon.outer, ...polygon.holes].map(toPath));
      kept = toPolygons(intersect(paths, shape.path)).filter((polygon) => polygonArea(polygon) > 2);
    }
    if (!kept.length) return;

    const firstVertex = positions.length / 3;
    const firstIndex = indices.length;
    let low = Number.POSITIVE_INFINITY;
    let high = Number.NEGATIVE_INFINITY;
    for (const polygon of kept) {
      const [min, max] = terrain.rangeUnder(polygon.outer);
      low = Math.min(low, min);
      high = Math.max(high, max);
    }
    // Stand on the slope: sink the walls to the lowest corner, measure the height from mid-slope.
    const ground = low + (high - low) * 0.5;
    const top = ground + height;
    const floating = minHeight > 0.5;
    const bottom = floating ? ground + minHeight : low - 0.6;
    let cx = 0;
    let cy = 0;
    let weight = 0;
    for (const polygon of kept) {
      extrude(polygon, bottom, top, low, floating);
      footprints.push(toPath(polygon.outer));
      const [px, py] = ringCentroid(polygon.outer);
      const a = Math.abs(ringArea(polygon.outer));
      cx += px * a;
      cy += py * a;
      weight += a;
    }
    ranges.push(firstVertex, positions.length / 3 - firstVertex, firstIndex, indices.length - firstIndex);
    anchors.push(cx / weight, low, -cy / weight, top);
    info.push(record);
  };

  for (const item of items) {
    const { tags, id } = item.feature;
    const size = dimensions(tags, id, item.area);
    const street = tags["addr:street"];
    const kind = tags.building && tags.building !== "yes" ? tags.building : (tags["building:part"] ?? "yes");
    emit(
      item.polygons,
      item.box,
      {
        id: Math.abs(id),
        name: tags.name,
        kind: kind === "yes" && tags.amenity ? tags.amenity : kind,
        height: Math.round((size.height - size.minHeight) * 10) / 10,
        levels: size.levels,
        address: street ? [street, tags["addr:housenumber"]].filter(Boolean).join(" ") : undefined,
        measured: size.measured,
      },
      size.height,
      size.minHeight,
    );
  }

  // Historic walls and similar linear structures arrive as ready-made footprints.
  for (const wall of walls) {
    for (const polygon of toPolygons(wall.layer)) {
      emit(
        [polygon],
        ringBox(polygon.outer),
        { id: 0, kind: "city_wall", height: wall.height, measured: false },
        wall.height,
        0,
      );
    }
  }

  return {
    data: {
      positions: new Float32Array(positions),
      normals: new Float32Array(normals),
      indices: new Uint32Array(indices),
      part: new Uint8Array(part),
      base: new Float32Array(base),
      owner: new Uint32Array(owner),
      ranges: new Uint32Array(ranges),
      anchors: new Float32Array(anchors),
      info,
      edges: new Float32Array(edges),
    },
    footprints,
    solids,
  };
}
