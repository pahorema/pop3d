import type { LayerId } from "../core/types";

/** Colours a user can override on top of any theme. */
export type ColorKey = Exclude<LayerId, "buildings" | "trees"> | "walls" | "roofs" | "trees" | "background";

export const COLOR_KEYS: ColorKey[] = [
  "background",
  "walls",
  "roofs",
  "roads",
  "paths",
  "ground",
  "green",
  "forest",
  "trees",
  "water",
  "farmland",
  "sand",
  "rock",
  "ice",
  "urban",
  "paved",
  "sport",
  "rail",
  "base",
];

export interface Theme {
  id: string;
  /** Whether the UI should use light text over this background. */
  dark: boolean;
  background: [top: string, bottom: string];
  layers: Record<Exclude<LayerId, "buildings" | "trees">, string>;
  /** Buildings pick one of these per building, for a little life. */
  walls: string[];
  roofs: string[];
  trees: { crowns: string[]; conifer: string; trunk: string };
  /** Thin lines drawn on the edges of buildings, for technical-drawing looks. */
  edges: { color: string; opacity: number } | null;
  light: {
    sun: string;
    sunIntensity: number;
    sky: string;
    bounce: string;
    skyIntensity: number;
    /** Strength of the soft studio lighting baked in the environment map. */
    environment: number;
    exposure: number;
  };
  surface: { roughness: number; waterRoughness: number; waterMetalness: number };
  ao: { intensity: number; color: string };
  shadow: { color: string; opacity: number };
}

const NATURAL_LIGHT: Theme["light"] = {
  sun: "#fff3e0",
  sunIntensity: 2.8,
  sky: "#eaf2ff",
  bounce: "#d9cdb8",
  skyIntensity: 1.15,
  environment: 0.26,
  exposure: 1,
};

export const THEMES: Theme[] = [
  {
    id: "diorama",
    dark: false,
    background: ["#f4f0e8", "#e3ddd0"],
    layers: {
      base: "#cdbfab",
      ground: "#ece6d8",
      urban: "#e7e0d1",
      farmland: "#e9dfb6",
      sand: "#f1e4b9",
      rock: "#d3cbbd",
      ice: "#f1f7fa",
      green: "#c6dd9f",
      forest: "#a9d093",
      water: "#9ad1e6",
      sport: "#a8d6a2",
      paved: "#dfd8cb",
      paths: "#f6efe2",
      roads: "#ffffff",
      rail: "#b3aca2",
    },
    walls: ["#fbf6ec", "#f7eddd", "#f4e8d6", "#f9f2e6"],
    roofs: ["#e08e6d", "#d98162", "#e49b7a", "#d27759"],
    trees: { crowns: ["#7fb87f", "#8fc388", "#70ab76"], conifer: "#4f9070", trunk: "#a18669" },
    edges: null,
    light: NATURAL_LIGHT,
    surface: { roughness: 0.92, waterRoughness: 0.12, waterMetalness: 0.1 },
    ao: { intensity: 2.6, color: "#3a2f28" },
    shadow: { color: "#4a3f35", opacity: 0.4 },
  },
  {
    id: "plastico",
    dark: false,
    background: ["#efede9", "#d9d6d0"],
    layers: {
      base: "#e2dfd9",
      ground: "#f3f1ed",
      urban: "#efede8",
      farmland: "#f1efea",
      sand: "#f1eee7",
      rock: "#ebe8e2",
      ice: "#f7f9fa",
      green: "#e6eae0",
      forest: "#dde4d7",
      water: "#cfdce2",
      sport: "#e3e8dd",
      paved: "#eae8e3",
      paths: "#f8f7f4",
      roads: "#ffffff",
      rail: "#cbc8c2",
    },
    walls: ["#ffffff", "#fdfcfa"],
    roofs: ["#fbfaf7", "#f8f6f2"],
    trees: { crowns: ["#e2e8dc", "#dbe3d5"], conifer: "#d3ddd0", trunk: "#d6d0c6" },
    edges: null,
    light: { ...NATURAL_LIGHT, sun: "#fff6ea", sunIntensity: 2.6, skyIntensity: 1.1, environment: 0.24 },
    surface: { roughness: 0.96, waterRoughness: 0.2, waterMetalness: 0 },
    ao: { intensity: 3.2, color: "#2e2b28" },
    shadow: { color: "#3c3936", opacity: 0.36 },
  },
  {
    id: "mediterraneo",
    dark: false,
    background: ["#f6ecda", "#ead9bd"],
    layers: {
      base: "#b98b63",
      ground: "#f0e1c5",
      urban: "#ecdbbd",
      farmland: "#e6d49a",
      sand: "#f5e3a8",
      rock: "#d9c6a5",
      ice: "#f3f6f4",
      green: "#bccb8c",
      forest: "#97b67b",
      water: "#5fbccb",
      sport: "#a9c489",
      paved: "#e6d6ba",
      paths: "#f8ecd6",
      roads: "#fff7e8",
      rail: "#a8977f",
    },
    walls: ["#fcefdb", "#f7e3c6", "#f3d8b6", "#fdf4e5", "#f6dcc0"],
    roofs: ["#d36a40", "#c85c36", "#dd7b4d", "#c2552f"],
    trees: { crowns: ["#6f9d5c", "#7dab66", "#5f8e52"], conifer: "#3f7a55", trunk: "#8d6c4c" },
    edges: null,
    light: { ...NATURAL_LIGHT, sun: "#ffe9c7", sunIntensity: 3, bounce: "#e0c59a" },
    surface: { roughness: 0.9, waterRoughness: 0.08, waterMetalness: 0.15 },
    ao: { intensity: 2.6, color: "#4a2c1c" },
    shadow: { color: "#5a3a22", opacity: 0.4 },
  },
  {
    id: "carta",
    dark: false,
    background: ["#f7f1e7", "#ebe1d1"],
    layers: {
      base: "#dfd2bf",
      ground: "#f2eadd",
      urban: "#eee4d5",
      farmland: "#ece0bf",
      sand: "#f0e3c4",
      rock: "#ddd2c0",
      ice: "#f2f1ec",
      green: "#d0d9b9",
      forest: "#b9c9a4",
      water: "#b6d3d8",
      sport: "#c4d3ae",
      paved: "#e6dccb",
      paths: "#faf4e8",
      roads: "#fffbf2",
      rail: "#bdb3a4",
    },
    walls: ["#eab9a1", "#efc7ae", "#e6ad99", "#f0d0b8"],
    roofs: ["#d99b87", "#d18f7b", "#e0a892"],
    trees: { crowns: ["#a9bd8f", "#b6c89c", "#9bb182"], conifer: "#86a17a", trunk: "#b79d82" },
    edges: null,
    light: { ...NATURAL_LIGHT, sunIntensity: 2.5, skyIntensity: 1.25 },
    surface: { roughness: 1, waterRoughness: 0.6, waterMetalness: 0 },
    ao: { intensity: 2.2, color: "#4d3a2e" },
    shadow: { color: "#57463a", opacity: 0.34 },
  },
  {
    id: "menta",
    dark: false,
    background: ["#fdf0f1", "#f8dde5"],
    layers: {
      base: "#f3c9d5",
      ground: "#fff5ee",
      urban: "#fdeee6",
      farmland: "#fdf0c4",
      sand: "#ffeebc",
      rock: "#ead9d6",
      ice: "#f4fbff",
      green: "#baedd4",
      forest: "#9fe1c4",
      water: "#a6d9ff",
      sport: "#a9e6c9",
      paved: "#f6e7e2",
      paths: "#fffaf5",
      roads: "#ffffff",
      rail: "#d3c2cc",
    },
    walls: ["#ffd9e2", "#ffe7ba", "#d9e5fd", "#e4f1cf", "#f3dcfb"],
    roofs: ["#ffb1cd", "#ffc9a4", "#bfe1ff", "#c3e3a9", "#e2bdf5"],
    trees: { crowns: ["#7fd8b1", "#92e0bd", "#6fceA4"], conifer: "#58c09a", trunk: "#d6a892" },
    edges: null,
    light: { ...NATURAL_LIGHT, sun: "#fff4f0", sky: "#f3ecff", bounce: "#ffd9e0" },
    surface: { roughness: 0.85, waterRoughness: 0.1, waterMetalness: 0.05 },
    ao: { intensity: 2.2, color: "#6b3f58" },
    shadow: { color: "#8a5672", opacity: 0.3 },
  },
  {
    id: "grafite",
    dark: true,
    background: ["#222327", "#131416"],
    layers: {
      base: "#1d1e21",
      ground: "#2b2d31",
      urban: "#2f3136",
      farmland: "#33342f",
      sand: "#3a3833",
      rock: "#3b3c40",
      ice: "#565a61",
      green: "#303a34",
      forest: "#2a352f",
      water: "#1f3b4b",
      sport: "#34413a",
      paved: "#35373c",
      paths: "#43464d",
      roads: "#54585f",
      rail: "#3b3d42",
    },
    walls: ["#dcd8cf", "#d3cfc6", "#e4e0d7"],
    roofs: ["#efebe2", "#e8e4db"],
    trees: { crowns: ["#3f4d43", "#465549"], conifer: "#36443b", trunk: "#3a3833" },
    edges: null,
    light: {
      sun: "#ffe7c9",
      sunIntensity: 3,
      sky: "#b9c6dd",
      bounce: "#2a2a2c",
      skyIntensity: 0.9,
      environment: 0.2,
      exposure: 1,
    },
    surface: { roughness: 0.88, waterRoughness: 0.15, waterMetalness: 0.3 },
    ao: { intensity: 2.8, color: "#000000" },
    shadow: { color: "#000000", opacity: 0.5 },
  },
  {
    id: "notte",
    dark: true,
    background: ["#111a30", "#070b16"],
    layers: {
      base: "#0f1626",
      ground: "#18223a",
      urban: "#1c2741",
      farmland: "#1a2b3c",
      sand: "#27304a",
      rock: "#232d49",
      ice: "#3a4a78",
      green: "#17393f",
      forest: "#13343a",
      water: "#0f4f7c",
      sport: "#1a4347",
      paved: "#212c48",
      paths: "#34436a",
      roads: "#4c5d8c",
      rail: "#27324f",
    },
    walls: ["#2c3860", "#313f6a", "#283356"],
    roofs: ["#3d4c80", "#44558c"],
    trees: { crowns: ["#1e5252", "#235b59"], conifer: "#194848", trunk: "#27304a" },
    edges: { color: "#9fdcff", opacity: 0.4 },
    light: {
      sun: "#bcd3ff",
      sunIntensity: 2.4,
      sky: "#7f9bd8",
      bounce: "#0d1322",
      skyIntensity: 1.1,
      environment: 0.22,
      exposure: 1.05,
    },
    surface: { roughness: 0.8, waterRoughness: 0.1, waterMetalness: 0.4 },
    ao: { intensity: 2.4, color: "#000309" },
    shadow: { color: "#000208", opacity: 0.5 },
  },
  {
    id: "blueprint",
    dark: true,
    background: ["#1b4fb3", "#0f3585"],
    layers: {
      base: "#123a8f",
      ground: "#1c50b4",
      urban: "#1f54ba",
      farmland: "#1e56b8",
      sand: "#2259bd",
      rock: "#2459bd",
      ice: "#3f76dc",
      green: "#1e5cb9",
      forest: "#1a57b0",
      water: "#113a92",
      sport: "#2260be",
      paved: "#2459be",
      paths: "#4f82dc",
      roads: "#7fa9f0",
      rail: "#3a69c8",
    },
    walls: ["#2a60c8", "#2d64cd"],
    roofs: ["#356dd6", "#3871da"],
    trees: { crowns: ["#3d78dc", "#4480e2"], conifer: "#3972d6", trunk: "#2a60c8" },
    edges: { color: "#ffffff", opacity: 0.75 },
    light: {
      sun: "#ffffff",
      sunIntensity: 2,
      sky: "#cfe0ff",
      bounce: "#0f3585",
      skyIntensity: 1.6,
      environment: 0.28,
      exposure: 1,
    },
    surface: { roughness: 1, waterRoughness: 0.5, waterMetalness: 0 },
    ao: { intensity: 1.8, color: "#061a4a" },
    shadow: { color: "#061a4a", opacity: 0.4 },
  },
];

export const DEFAULT_THEME = "diorama";

/** Which palette entry gives each layer its colour in exported, multi-colour prints. */
export const LAYER_COLOR_KEY: Record<LayerId, ColorKey> = {
  base: "ground",
  ground: "ground",
  urban: "urban",
  farmland: "farmland",
  sand: "sand",
  rock: "rock",
  ice: "ice",
  green: "green",
  forest: "forest",
  water: "water",
  sport: "sport",
  paved: "paved",
  paths: "paths",
  roads: "roads",
  rail: "rail",
  buildings: "walls",
  trees: "trees",
};

export function findTheme(id: string): Theme {
  return THEMES.find((theme) => theme.id === id) ?? THEMES[0]!;
}

/** Applies the user's colour overrides to a theme. */
export function resolveTheme(id: string, overrides: Partial<Record<ColorKey, string>>): Theme {
  const theme = findTheme(id);
  if (!Object.keys(overrides).length) return theme;
  const layers = { ...theme.layers };
  for (const key in layers) {
    const override = overrides[key as ColorKey];
    if (override) layers[key as keyof typeof layers] = override;
  }
  return {
    ...theme,
    layers,
    background: overrides.background ? [overrides.background, overrides.background] : theme.background,
    walls: overrides.walls ? [overrides.walls] : theme.walls,
    roofs: overrides.roofs ? [overrides.roofs] : theme.roofs,
    trees: overrides.trees
      ? { ...theme.trees, crowns: [overrides.trees], conifer: overrides.trees }
      : theme.trees,
  };
}

/** The colour shown for a key in the palette editor. */
export function themeColor(theme: Theme, key: ColorKey): string {
  switch (key) {
    case "background":
      return theme.background[0];
    case "walls":
      return theme.walls[0]!;
    case "roofs":
      return theme.roofs[0]!;
    case "trees":
      return theme.trees.crowns[0]!;
    default:
      return theme.layers[key];
  }
}
