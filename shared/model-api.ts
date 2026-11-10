import type { Detail, LayerId, ShapeKind } from "../src/core/types";
import type { BuildingColorMode } from "../src/scene/diorama";
import type { ColorKey } from "../src/scene/themes";

/** What `/api/model` can return. */
export const MODEL_FORMATS = ["glb", "obj", "stl", "3mf", "json"] as const;
export type ModelFormat = (typeof MODEL_FORMATS)[number];

export const MODEL_SHAPES: ShapeKind[] = ["circle", "square", "rounded", "hexagon"];
export const MODEL_BUILDING_COLORS: BuildingColorMode[] = ["theme", "height", "kind"];

/** Every option of `/api/model`, after defaults have been applied. */
export interface ModelOptions {
  /** Free-text place to geocode, used when no coordinates are given. */
  q?: string;
  lat?: number;
  lon?: number;
  shape: ShapeKind;
  width: number;
  depth: number;
  detail: Detail;
  relief: number;
  roofs: boolean;
  format: ModelFormat;
  theme: string;
  colors: Partial<Record<ColorKey, string>>;
  buildings: BuildingColorMode;
  /** When set, only these layers are kept. */
  layers: LayerId[] | null;
  /** Layers left out. */
  hide: LayerId[];
  /** Longest side of the printed model, in millimetres. */
  printSize: number;
  printBase: number;
  printZScale: number;
  printFeature: number;
  lang: "it" | "en";
  download: boolean;
}

export const MODEL_DEFAULTS: ModelOptions = {
  shape: "circle",
  width: 800,
  depth: 800,
  detail: 1,
  relief: 1,
  roofs: true,
  format: "glb",
  theme: "diorama",
  colors: {},
  buildings: "theme",
  layers: null,
  hide: [],
  printSize: 150,
  printBase: 3,
  printZScale: 1.5,
  printFeature: 0.4,
  lang: "en",
  download: false,
};

/** Layers that go into a print when none are asked for explicitly. */
export const DEFAULT_PRINT_LAYERS: LayerId[] = ["base", "buildings", "roads", "paths", "rail", "water"];

export const MODEL_LIMITS = {
  size: [120, 5000],
  relief: [0, 3],
  printSize: [20, 400],
  printBase: [0.6, 20],
  printZScale: [1, 4],
  printFeature: [0.2, 1.2],
} as const;

/** Builds the query string of a model request, leaving out whatever equals the defaults. */
export function modelQuery(options: Partial<ModelOptions>): string {
  const d = MODEL_DEFAULTS;
  const query = new URLSearchParams();
  if (options.lat !== undefined && options.lon !== undefined) {
    query.set("lat", options.lat.toFixed(5));
    query.set("lon", options.lon.toFixed(5));
  } else if (options.q) {
    query.set("q", options.q);
  }
  const width = options.width ?? d.width;
  const depth = options.depth ?? width;
  if (width !== depth) {
    query.set("width", String(width));
    query.set("depth", String(depth));
  } else if (width !== d.width) {
    query.set("size", String(width));
  }
  const put = (name: string, value: string | number | boolean | undefined, fallback: unknown) => {
    if (value !== undefined && value !== fallback) query.set(name, String(value));
  };
  put("shape", options.shape, d.shape);
  put("detail", options.detail, d.detail);
  put("relief", options.relief, d.relief);
  put("roofs", options.roofs, d.roofs);
  put("theme", options.theme, d.theme);
  put("buildings", options.buildings, d.buildings);
  const colors = Object.entries(options.colors ?? {});
  if (colors.length) {
    query.set("colors", colors.map(([key, value]) => `${key}:${value.replace("#", "")}`).join(","));
  }
  if (options.layers?.length) query.set("layers", options.layers.join(","));
  if (options.hide?.length) query.set("hide", options.hide.join(","));
  put("print_size", options.printSize, d.printSize);
  put("print_base", options.printBase, d.printBase);
  put("print_zscale", options.printZScale, d.printZScale);
  put("print_feature", options.printFeature, d.printFeature);
  put("lang", options.lang, d.lang);
  put("format", options.format, d.format);
  put("download", options.download, d.download);
  return query.toString().replace(/%2C/g, ",").replace(/%3A/g, ":");
}
