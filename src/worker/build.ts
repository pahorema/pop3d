import earcut from "earcut";
import type { OsmPayload } from "../../shared/types";
import type { BuildParams, DioramaData, LayerId, MeshData } from "../core/types";
import { projector, shapeRing } from "../geo/projection";
import { type BuildingSolid, buildBuildings } from "./buildings";
import {
  clipLinesToBox,
  difference,
  fromPath,
  inflateLines,
  inflatePolygons,
  intersect,
  normalize,
  type Paths64,
  SCALE,
  toPath,
  toRings,
  union,
} from "./clip";
import { seaPolygons } from "./coast";
import { type AreaKind, type LineLayer, readFeatures } from "./features";
import { Heightfield } from "./heightfield";
import { addFlatSurface, addSurface, addWalls, MeshBuilder } from "./mesh";
import { type Box, distanceToRing, type Ring } from "./poly";
import { type Tessellation, tessellate } from "./tessellate";
import { plantTrees, type TreeZone } from "./trees";

/**
 * The terrain grid is padded by a hair so that its lines never coincide with polygon vertices,
 * which are rounded to whole centimetres by the clipper.
 */
export const GRID_PAD = 0.00371;

/** Number of terrain cells per side for the given settings. */
export function gridCells(params: BuildParams): number {
  if (params.relief <= 0) return 28;
  const span = Math.max(params.area.width, params.area.depth);
  const target = [72, 120, 176][params.detail]!;
  return Math.max(32, Math.min(target, Math.round(span / 2.5)));
}

const AREA_LAYER: Record<AreaKind, LayerId | null> = {
  water: null,
  lake: null,
  green: "green",
  park: "green",
  scrub: "green",
  forest: "forest",
  farmland: "farmland",
  orchard: "farmland",
  sand: "sand",
  urban: "urban",
  sport: "sport",
  paved: "paved",
};

/** Height of each layer above the terrain, in layer units: thin stacked sheets, like cut paper. */
const LIFT: Partial<Record<LayerId, number>> = {
  urban: 0.2,
  farmland: 0.3,
  sand: 0.4,
  green: 0.5,
  forest: 0.65,
  sport: 0.8,
  paved: 0.9,
  paths: 1.0,
  roads: 1.2,
  rail: 1.35,
};

const TREE_LIMIT = [0, 14_000, 36_000];

/** Everything the 3D-print export needs to rebuild the model as watertight solids. */
export interface BuildState {
  params: BuildParams;
  terrain: Heightfield;
  ring: Ring;
  unit: number;
  bankDepth: number;
  waterDrop: number;
  bottomY: number;
  sheets: Partial<Record<LayerId, Paths64>>;
  solids: BuildingSolid[];
  trees: DioramaData["trees"];
}

function grow(box: Box, by: number): Box {
  return { minX: box.minX - by, minY: box.minY - by, maxX: box.maxX + by, maxY: box.maxY + by };
}

function percentile(values: number[], q: number): number {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]!;
}

function triangulateRing(ring: Ring): Tessellation {
  const indices = earcut(ring);
  const triangles: number[] = [];
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i]!;
    const b = indices[i + 1]!;
    const c = indices[i + 2]!;
    const cross =
      (ring[b * 2]! - ring[a * 2]!) * (ring[c * 2 + 1]! - ring[a * 2 + 1]!) -
      (ring[b * 2 + 1]! - ring[a * 2 + 1]!) * (ring[c * 2]! - ring[a * 2]!);
    if (cross > 0) triangles.push(a, b, c);
    else triangles.push(a, c, b);
  }
  return { xy: ring, triangles, edges: [] };
}

export function buildDiorama(
  params: BuildParams,
  osm: OsmPayload,
  elevation: Float32Array | null,
  progress: (ratio: number) => void,
): { data: DioramaData; state: BuildState } {
  const started = performance.now();
  const { area, detail } = params;
  const relief = elevation ? Math.max(0, params.relief) : 0;
  const projection = projector(area.lat, area.lon);
  const shapePath: Paths64 = [toPath(shapeRing(area.shape, area.width, area.depth))];
  const ring = fromPath(shapePath[0]!);
  const box: Box = {
    minX: -area.width / 2,
    minY: -area.depth / 2,
    maxX: area.width / 2,
    maxY: area.depth / 2,
  };
  const span = Math.max(area.width, area.depth);
  const unit = Math.min(0.9, Math.max(0.12, span / 1500));
  const bankDepth = unit * 2.2;
  const waterDrop = bankDepth * 0.6;
  const n = gridCells(params);

  const features = readFeatures(osm, projection, grow(box, 40), detail);
  progress(0.08);

  // ---- Collect raw shapes per kind -------------------------------------------------------
  const byKind = new Map<AreaKind, Paths64>();
  const lakes: Paths64[] = [];
  for (const feature of features.areas) {
    const paths = normalize(feature.rings);
    if (!paths.length) continue;
    const kind = feature.kind === "lake" ? "water" : feature.kind;
    if (feature.kind === "lake") lakes.push(paths);
    const list = byKind.get(kind);
    if (list) for (const path of paths) list.push(path);
    else byKind.set(kind, paths);
  }

  // Lines are buffered into ribbons, grouped by layer and width.
  const reach = grow(box, 45);
  const groups = new Map<string, { layer: LineLayer; width: number; lines: Paths64 }>();
  let roadMetres = 0;
  for (const feature of features.lines) {
    const width = Math.round(feature.width * 2) / 2;
    const key = `${feature.layer}:${width}`;
    let group = groups.get(key);
    if (!group) groups.set(key, (group = { layer: feature.layer, width, lines: [] }));
    group.lines.push(toPath(feature.line));
  }
  const ribbons = new Map<LineLayer, Paths64>();
  for (const group of groups.values()) {
    const lines = clipLinesToBox(group.lines, reach.minX, reach.minY, reach.maxX, reach.maxY);
    if (!lines.length) continue;
    if (group.layer === "roads") {
      const inside = clipLinesToBox(lines, box.minX, box.minY, box.maxX, box.maxY);
      for (const line of inside) {
        for (let i = 1; i < line.length; i++) {
          roadMetres += Math.hypot(line[i]!.x - line[i - 1]!.x, line[i]!.y - line[i - 1]!.y) / SCALE;
        }
      }
    }
    const inflated = inflateLines(lines, group.width);
    const list = ribbons.get(group.layer);
    if (list) for (const path of inflated) list.push(path);
    else ribbons.set(group.layer, inflated);
  }
  progress(0.2);

  // ---- Water ------------------------------------------------------------------------------
  const sea = seaPolygons(features.coastlines, grow(box, 30));
  const water = intersect(
    union([...(byKind.get("water") ?? []), ...(ribbons.get("water") ?? []), ...sea]),
    shapePath,
  );
  progress(0.28);

  // ---- Terrain ----------------------------------------------------------------------------
  const terrain = new Heightfield(
    n,
    box.minX - GRID_PAD,
    box.minY - GRID_PAD,
    box.maxX + GRID_PAD,
    box.maxY + GRID_PAD,
  );
  let elevationRange: [number, number] = [0, 0];
  if (relief > 0 && elevation && elevation.length === terrain.heights.length) {
    const heights = terrain.heights;
    heights.set(elevation);
    const levels: { samples: number[]; level: number }[] = [];
    const seaRings = toRings(sea);
    if (seaRings.length) levels.push({ samples: terrain.samplesUnder(seaRings), level: 0 });
    for (const lake of lakes) {
      const samples = terrain.samplesUnder(toRings(lake));
      if (samples.length) {
        levels.push({
          samples,
          level: percentile(
            samples.map((i) => heights[i]!),
            0.15,
          ),
        });
      }
    }
    const flatten = () => {
      // Next to the sea, noise in the elevation model must not dig below the waterline.
      if (seaRings.length) for (let i = 0; i < heights.length; i++) if (heights[i]! < 0) heights[i] = 0;
      for (const { samples, level } of levels) for (const i of samples) heights[i] = level;
    };
    // Water is level: pin it before smoothing so the shores blend, and again after so it stays flat.
    flatten();
    const sigmaMetres = Math.min(26, Math.max(5, span / 80));
    terrain.smooth(sigmaMetres / ((terrain.cellX + terrain.cellY) / 2));
    flatten();

    const inside = terrain.rasterize([ring], 1);
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < heights.length; i++) {
      if (!inside[i]) continue;
      if (heights[i]! < min) min = heights[i]!;
      if (heights[i]! > max) max = heights[i]!;
    }
    if (min > max) {
      min = 0;
      max = 0;
    }
    elevationRange = [min, max];
    for (let i = 0; i < heights.length; i++) heights[i] = (Math.max(min, heights[i]!) - min) * relief;
    terrain.refresh();
  }
  const groundTopY = (elevationRange[1] - elevationRange[0]) * relief;
  const bottomY = -Math.max(span * 0.045, bankDepth * 4);
  progress(0.36);

  // ---- Sheets: one set of outlines per layer ----------------------------------------------
  const sheets: Partial<Record<LayerId, Paths64>> = {};
  const collected = new Map<LayerId, Paths64>();
  for (const [kind, paths] of byKind) {
    const layer = AREA_LAYER[kind];
    if (!layer) continue;
    const list = collected.get(layer);
    if (list) for (const path of paths) list.push(path);
    else collected.set(layer, paths.slice());
  }
  const pavedRibbons = ribbons.get("paved");
  if (pavedRibbons) collected.set("paved", [...(collected.get("paved") ?? []), ...pavedRibbons]);
  for (const [layer, paths] of collected) {
    const clipped = intersect(union(paths), shapePath);
    // Piers and quays stand over the water; everything else stops at the shore.
    sheets[layer] = layer === "paved" ? clipped : difference(clipped, water);
  }
  for (const layer of ["roads", "paths", "rail"] as const) {
    const paths = ribbons.get(layer);
    if (paths) sheets[layer] = intersect(union(paths), shapePath);
  }
  sheets.water = water;
  sheets.ground = difference(shapePath, water);
  progress(0.5);

  // ---- Meshes -----------------------------------------------------------------------------
  const layers: Partial<Record<LayerId, MeshData>> = {};
  const height = (x: number, y: number) => terrain.heightAt(x, y);
  const onOutline = (ax: number, ay: number, bx: number, by: number) =>
    distanceToRing((ax + bx) / 2, (ay + by) / 2, ring) < 0.03;

  const base = new MeshBuilder();

  const groundTess = tessellate(toRings(sheets.ground), terrain);
  const ground = new MeshBuilder();
  addSurface(ground, groundTess, terrain, 0);
  addWalls(ground, groundTess.edges, height, (x, y) => height(x, y) - bankDepth);
  addWalls(
    base,
    groundTess.edges,
    (x, y) => height(x, y) - bankDepth,
    () => bottomY,
    onOutline,
  );
  layers.ground = ground.finish();
  progress(0.6);

  if (water.length) {
    const waterTess = tessellate(toRings(water), terrain);
    const mesh = new MeshBuilder();
    const band = bankDepth * 1.6;
    addSurface(mesh, waterTess, terrain, -waterDrop);
    // Where water reaches the rim, show a slice of it like resin in a model.
    addWalls(
      mesh,
      waterTess.edges,
      (x, y) => height(x, y) - waterDrop,
      (x, y) => height(x, y) - waterDrop - band,
      onOutline,
    );
    addWalls(
      base,
      waterTess.edges,
      (x, y) => height(x, y) - waterDrop - band,
      () => bottomY,
      onOutline,
    );
    layers.water = mesh.finish();
  }

  const stacked = Object.keys(LIFT) as LayerId[];
  stacked.forEach((layer, index) => {
    const paths = sheets[layer];
    if (!paths?.length) return;
    const lift = LIFT[layer]! * unit;
    const tess = tessellate(toRings(paths), terrain);
    const mesh = new MeshBuilder();
    addSurface(mesh, tess, terrain, lift);
    addWalls(mesh, tess.edges, (x, y) => height(x, y) + lift, height);
    if (mesh.triangleCount) layers[layer] = mesh.finish();
    progress(0.62 + (0.16 * (index + 1)) / stacked.length);
  });

  addFlatSurface(base, triangulateRing(ring), bottomY, false);
  layers.base = base.finish();

  // ---- Buildings --------------------------------------------------------------------------
  const wallRibbons = ribbons.get("wall");
  const buildings = buildBuildings(
    features.buildings,
    terrain,
    { ring, path: shapePath, box },
    detail,
    params.roofs && detail > 0,
    wallRibbons ? [{ layer: intersect(union(wallRibbons), shapePath), height: 8 }] : [],
  );
  progress(0.88);

  // ---- Trees ------------------------------------------------------------------------------
  let trees: DioramaData["trees"] = { count: 0, data: new Float32Array(0), kinds: new Uint8Array(0) };
  if (detail > 0) {
    const blocked = union([
      ...buildings.footprints,
      ...(sheets.roads ?? []),
      ...(sheets.rail ?? []),
      ...(sheets.paths ?? []),
      ...(sheets.sport ?? []),
      ...water,
    ]);
    const inner = inflatePolygons(shapePath, -Math.min(3, span * 0.01));
    const zone = (kind: AreaKind): Paths64 => {
      const paths = byKind.get(kind);
      return paths?.length ? difference(intersect(union(paths), inner), blocked) : [];
    };
    const dense = detail === 2;
    const zones: TreeZone[] = [
      {
        paths: zone("forest"),
        spacing: dense ? 8 : 11,
        minHeight: 8,
        maxHeight: 15,
        conifers: 0.2,
        jitter: 1,
      },
      {
        paths: zone("scrub"),
        spacing: dense ? 11 : 15,
        minHeight: 2.5,
        maxHeight: 5,
        conifers: 0.1,
        jitter: 1,
      },
      {
        paths: zone("park"),
        spacing: dense ? 19 : 27,
        minHeight: 6,
        maxHeight: 11,
        conifers: 0.08,
        jitter: 1,
      },
      {
        paths: zone("orchard"),
        spacing: dense ? 6.5 : 9,
        minHeight: 3.2,
        maxHeight: 4.4,
        conifers: 0,
        jitter: 0,
      },
    ];
    trees = plantTrees({
      mapped: features.trees,
      rows: features.treeRows,
      zones: zones.filter((z) => z.paths.length),
      terrain,
      bounds: toRings(inner)[0] ?? ring,
      lift: unit * 0.45,
      limit: TREE_LIMIT[detail]!,
      seed: Math.round(Math.abs(area.lat * 1e4) + Math.abs(area.lon * 1e4)),
    });
  }
  progress(0.96);

  let triangles = buildings.data.indices.length / 3;
  for (const mesh of Object.values(layers)) triangles += mesh.indices.length / 3;
  let topY = groundTopY;
  const anchors = buildings.data.anchors;
  for (let i = 3; i < anchors.length; i += 4) if (anchors[i]! > topY) topY = anchors[i]!;

  const data: DioramaData = {
    params,
    bottomY,
    topY,
    groundTopY,
    layers,
    buildings: buildings.data,
    trees,
    terrain: {
      size: n + 1,
      minX: terrain.minX,
      minZ: -terrain.maxY,
      cellX: terrain.cellX,
      cellZ: terrain.cellY,
      heights: terrain.heights.slice(),
    },
    stats: {
      buildings: buildings.data.info.length,
      trees: trees.count,
      roadKm: roadMetres / 1000,
      triangles: Math.round(triangles),
      elevation: elevationRange,
      osmTimestamp: features.timestamp,
      buildMs: Math.round(performance.now() - started),
    },
  };
  return {
    data,
    state: {
      params,
      terrain,
      ring,
      unit,
      bankDepth,
      waterDrop,
      bottomY,
      sheets,
      solids: buildings.solids,
      trees,
    },
  };
}
