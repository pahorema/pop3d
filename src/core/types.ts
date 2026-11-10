/** Outline of the diorama, seen from above. */
export type ShapeKind = "circle" | "square" | "rounded" | "hexagon";

/** The piece of world to rebuild: a centre plus the footprint drawn around it. */
export interface Area {
  lat: number;
  lon: number;
  shape: ShapeKind;
  /** East-west extent in metres. */
  width: number;
  /** North-south extent in metres. */
  depth: number;
}

/** 0 = essential, 1 = balanced, 2 = rich. */
export type Detail = 0 | 1 | 2;

export interface BuildParams {
  area: Area;
  detail: Detail;
  /** Vertical exaggeration of the terrain: 0 flattens it, 1 keeps true proportions. */
  relief: number;
  /** Give pitched roofs to buildings that are tagged with one, or look like houses. */
  roofs: boolean;
}

/** Every independently styled and toggled part of a diorama, in stacking order. */
export const LAYERS = [
  "base",
  "ground",
  "urban",
  "farmland",
  "sand",
  "rock",
  "ice",
  "green",
  "forest",
  "water",
  "sport",
  "paved",
  "paths",
  "roads",
  "rail",
  "buildings",
  "trees",
] as const;

export type LayerId = (typeof LAYERS)[number];

export interface MeshData {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
}

export interface BuildingInfo {
  id: number;
  name?: string;
  /** Raw OSM building value: "house", "church", "yes"... */
  kind: string;
  /** Height above ground in metres. */
  height: number;
  levels?: number;
  address?: string;
  /** True when the height comes from OSM tags rather than from a guess. */
  measured: boolean;
}

export interface BuildingsData extends MeshData {
  /** Per vertex: 0 for walls, 1 for roofs. */
  part: Uint8Array;
  /** Per vertex: elevation the building grows from during the build-in animation. */
  base: Float32Array;
  /** Per vertex: index of the owning building. */
  owner: Uint32Array;
  /** Per building: first vertex, vertex count, first index, index count. */
  ranges: Uint32Array;
  /** Per building: centre x, ground elevation, centre z, top elevation. */
  anchors: Float32Array;
  info: BuildingInfo[];
  /** Line segments (x, y, z pairs) tracing the hard edges, for outlined styles. */
  edges: Float32Array;
}

export const TREE_STRIDE = 6;

export interface TreesData {
  count: number;
  /** Per tree: x, y, z, height, crown radius, random seed in [0, 1). */
  data: Float32Array;
  /** Per tree: 0 broadleaved, 1 conifer. */
  kinds: Uint8Array;
}

export interface TerrainData {
  /** Samples per side of the square grid. */
  size: number;
  minX: number;
  minZ: number;
  cellX: number;
  cellZ: number;
  /** Row-major elevations in scene units; row 0 is the northern edge. */
  heights: Float32Array;
}

export interface DioramaStats {
  buildings: number;
  trees: number;
  roadKm: number;
  triangles: number;
  /** Real-world elevation range inside the area, in metres. */
  elevation: [number, number];
  osmTimestamp: string;
  buildMs: number;
}

export interface DioramaData {
  params: BuildParams;
  /** Elevation of the underside of the plinth. */
  bottomY: number;
  /** Highest point of the model. */
  topY: number;
  /** Highest point of the terrain alone. */
  groundTopY: number;
  layers: Partial<Record<LayerId, MeshData>>;
  buildings: BuildingsData;
  trees: TreesData;
  terrain: TerrainData;
  stats: DioramaStats;
}

export type BuildStage = "osm" | "terrain" | "geometry";

export interface PrintParams {
  /** Longest side of the printed model, in millimetres. */
  sizeMm: number;
  /** Thickness of the plinth under the lowest terrain point, in millimetres. */
  baseMm: number;
  /** Extra vertical exaggeration applied to buildings and terrain so they read at small scale. */
  zScale: number;
  /** Smallest printable feature, in millimetres; thinner details are thickened or dropped. */
  minFeatureMm: number;
  layers: LayerId[];
}

export interface PrintPart {
  layer: LayerId;
  /** Triangle soup in millimetres, Z up: 9 floats per triangle. */
  triangles: Float32Array;
}

export type WorkerRequest =
  | { type: "build"; id: number; params: BuildParams }
  | { type: "print"; id: number; params: PrintParams };

export type WorkerResponse =
  | { type: "progress"; id: number; stage: BuildStage; ratio: number }
  | { type: "built"; id: number; data: DioramaData }
  | { type: "printed"; id: number; parts: PrintPart[]; scale: number }
  | { type: "error"; id: number; code: string; message: string };
