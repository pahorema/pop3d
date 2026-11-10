import type { BuildingColorMode } from "../scene/diorama";
import { type ColorKey, DEFAULT_THEME, THEMES } from "../scene/themes";
import type { ViewSettings } from "../scene/viewer";
import type { Lang } from "./i18n";
import type { Area, BuildParams, Detail, LayerId, ShapeKind } from "./types";

export type PanelId = "area" | "style" | "layers" | "light" | "export";

export interface PlaceLabel {
  name: string;
  detail: string;
}

export interface AppState {
  place: PlaceLabel | null;
  area: Area;
  /** Whether width and depth can differ. */
  freeAspect: boolean;
  detail: Detail;
  relief: number;
  roofs: boolean;
  theme: string;
  colors: Partial<Record<ColorKey, string>>;
  buildingColors: BuildingColorMode;
  edges: boolean;
  faceted: boolean;
  hidden: LayerId[];
  solo: LayerId | null;
  view: ViewSettings;
  panel: PanelId | null;
  lang: Lang;
}

export const MIN_SPAN = 120;
export const MAX_SPAN = 5000;

export const DEFAULT_PLACE: PlaceLabel & { lat: number; lon: number; span: number } = {
  name: "Piazza Unità d'Italia",
  detail: "Trieste, Friuli-Venezia Giulia, Italia",
  lat: 45.6503,
  lon: 13.7678,
  span: 800,
};

export function defaultState(lang: Lang): AppState {
  return {
    place: { name: DEFAULT_PLACE.name, detail: DEFAULT_PLACE.detail },
    area: {
      lat: DEFAULT_PLACE.lat,
      lon: DEFAULT_PLACE.lon,
      shape: "circle",
      width: DEFAULT_PLACE.span,
      depth: DEFAULT_PLACE.span,
    },
    freeAspect: false,
    detail: 1,
    relief: 1.4,
    roofs: true,
    theme: DEFAULT_THEME,
    colors: {},
    buildingColors: "theme",
    edges: false,
    faceted: false,
    hidden: [],
    solo: null,
    view: {
      shadows: true,
      shadowSoftness: 3,
      ambientOcclusion: true,
      miniature: 0.45,
      sunAzimuth: 135,
      sunElevation: 40,
      autoRotate: false,
    },
    panel: null,
    lang,
  };
}

type Listener = (state: AppState, changed: ReadonlySet<keyof AppState>) => void;

/** Minimal observable state container: components subscribe and redraw what changed. */
export class Store {
  private listeners = new Set<Listener>();

  constructor(public state: AppState) {}

  set(patch: Partial<AppState>): void {
    const changed = new Set<keyof AppState>();
    for (const key of Object.keys(patch) as (keyof AppState)[]) {
      if (this.state[key] !== patch[key]) changed.add(key);
    }
    if (!changed.size) return;
    this.state = { ...this.state, ...patch };
    for (const listener of [...this.listeners]) listener(this.state, changed);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Runs `listener` whenever one of `keys` changes. */
  on(keys: (keyof AppState)[], listener: (state: AppState) => void): () => void {
    return this.subscribe((state, changed) => {
      if (keys.some((key) => changed.has(key))) listener(state);
    });
  }
}

export function buildParams(state: AppState): BuildParams {
  return { area: state.area, detail: state.detail, relief: state.relief, roofs: state.roofs };
}

/** True when two parameter sets need different source data (not just a different build). */
export function sameSource(a: BuildParams, b: BuildParams): boolean {
  return (
    a.area.lat === b.area.lat &&
    a.area.lon === b.area.lon &&
    a.area.width === b.area.width &&
    a.area.depth === b.area.depth
  );
}

export function sameBuild(a: BuildParams, b: BuildParams): boolean {
  return (
    sameSource(a, b) &&
    a.area.shape === b.area.shape &&
    a.detail === b.detail &&
    a.relief === b.relief &&
    a.roofs === b.roofs
  );
}

// ---- Persistence ----------------------------------------------------------------------------

const PREFS_KEY = "pop3d.prefs.v1";
const SHAPES: ShapeKind[] = ["circle", "square", "rounded", "hexagon"];
const PERSISTED: (keyof AppState)[] = [
  "detail",
  "relief",
  "roofs",
  "theme",
  "colors",
  "buildingColors",
  "edges",
  "faceted",
  "view",
];

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function loadPreferences(state: AppState): AppState {
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "null");
    if (!saved || typeof saved !== "object") return state;
    const next = { ...state };
    for (const key of PERSISTED) {
      if (key in saved && typeof saved[key] === typeof state[key]) {
        (next as Record<string, unknown>)[key] =
          key === "view" ? { ...state.view, ...saved.view, autoRotate: false } : saved[key];
      }
    }
    if (!THEMES.some((theme) => theme.id === next.theme)) next.theme = DEFAULT_THEME;
    return next;
  } catch {
    return state;
  }
}

export function savePreferences(state: AppState): void {
  try {
    const subset: Record<string, unknown> = {};
    for (const key of PERSISTED) subset[key] = state[key];
    localStorage.setItem(PREFS_KEY, JSON.stringify(subset));
  } catch {
    // Storage may be unavailable (private mode): preferences simply do not persist.
  }
}

/** Reads the shareable part of the state from the page address. */
export function readUrl(state: AppState, search: string): { state: AppState; hasPlace: boolean } {
  const query = new URLSearchParams(search);
  const next = { ...state, area: { ...state.area } };
  let hasPlace = false;
  const centre = query.get("c")?.split(",").map(Number);
  if (centre?.length === 2 && Math.abs(centre[0]!) <= 85 && Math.abs(centre[1]!) <= 180) {
    next.area.lat = centre[0]!;
    next.area.lon = centre[1]!;
    next.place = query.get("n") ? { name: query.get("n")!, detail: query.get("in") ?? "" } : null;
    hasPlace = true;
  }
  const size = query.get("s")?.split("x").map(Number);
  if (size?.[0] && Number.isFinite(size[0])) {
    next.area.width = clamp(size[0], MIN_SPAN, MAX_SPAN);
    next.area.depth = clamp(size[1] && Number.isFinite(size[1]) ? size[1] : size[0], MIN_SPAN, MAX_SPAN);
    next.freeAspect = next.area.width !== next.area.depth;
  }
  const shape = query.get("f") as ShapeKind | null;
  if (shape && SHAPES.includes(shape)) next.area.shape = shape;
  const detail = Number(query.get("d"));
  if (query.has("d") && [0, 1, 2].includes(detail)) next.detail = detail as Detail;
  const relief = Number(query.get("r"));
  if (query.has("r") && Number.isFinite(relief)) next.relief = clamp(relief, 0, 3);
  const theme = query.get("t");
  if (theme && THEMES.some((item) => item.id === theme)) next.theme = theme;
  return { state: next, hasPlace };
}

/** The address that reproduces the current diorama. */
export function writeUrl(state: AppState): string {
  const { area } = state;
  const query = new URLSearchParams();
  query.set("c", `${area.lat.toFixed(5)},${area.lon.toFixed(5)}`);
  query.set("s", area.width === area.depth ? String(area.width) : `${area.width}x${area.depth}`);
  if (area.shape !== "circle") query.set("f", area.shape);
  query.set("d", String(state.detail));
  query.set("r", String(state.relief));
  query.set("t", state.theme);
  if (state.place?.name) {
    query.set("n", state.place.name);
    if (state.place.detail) query.set("in", state.place.detail);
  }
  return `?${query.toString().replace(/%2C/g, ",")}`;
}
