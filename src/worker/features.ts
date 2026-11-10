import { OSM_COORD_SCALE, type OsmPayload, type OsmTags } from "../../shared/types";
import type { Detail } from "../core/types";
import type { Projection } from "../geo/projection";
import { type Box, boxesOverlap, type Ring, ringBox } from "./poly";

export type AreaKind =
  | "water"
  | "lake"
  | "green"
  | "park"
  | "scrub"
  | "forest"
  | "farmland"
  | "orchard"
  | "sand"
  | "rock"
  | "ice"
  | "urban"
  | "sport"
  | "paved";

export type LineLayer = "roads" | "paths" | "rail" | "water" | "paved" | "wall";

export interface AreaFeature {
  kind: AreaKind;
  rings: Ring[];
}

export interface LineFeature {
  layer: LineLayer;
  width: number;
  line: Ring;
  bridge: boolean;
}

export interface BuildingFeature {
  id: number;
  tags: OsmTags;
  rings: Ring[];
  part: boolean;
}

export interface TreeFeature {
  x: number;
  y: number;
  conifer: boolean;
}

export interface Features {
  areas: AreaFeature[];
  lines: LineFeature[];
  buildings: BuildingFeature[];
  coastlines: Ring[];
  trees: TreeFeature[];
  treeRows: { line: Ring; conifer: boolean }[];
  timestamp: string;
}

const AREA_RULES: Record<string, Record<string, AreaKind>> = {
  natural: {
    water: "water",
    wood: "forest",
    scrub: "scrub",
    grassland: "green",
    heath: "green",
    fell: "green",
    wetland: "green",
    beach: "sand",
    sand: "sand",
    bare_rock: "rock",
    scree: "rock",
    shingle: "rock",
    glacier: "ice",
  },
  landuse: {
    forest: "forest",
    grass: "green",
    meadow: "green",
    village_green: "green",
    recreation_ground: "green",
    cemetery: "green",
    flowerbed: "green",
    plant_nursery: "green",
    farmland: "farmland",
    vineyard: "farmland",
    allotments: "farmland",
    greenhouse_horticulture: "farmland",
    orchard: "orchard",
    residential: "urban",
    commercial: "urban",
    retail: "urban",
    industrial: "urban",
    railway: "urban",
    construction: "urban",
    brownfield: "urban",
    religious: "urban",
    education: "urban",
    farmyard: "urban",
    quarry: "rock",
    basin: "water",
    reservoir: "lake",
    salt_pond: "water",
  },
  leisure: {
    park: "park",
    garden: "park",
    playground: "green",
    golf_course: "green",
    common: "green",
    dog_park: "green",
    recreation_ground: "green",
    miniature_golf: "green",
    pitch: "sport",
    track: "sport",
    swimming_pool: "water",
  },
  amenity: {
    parking: "paved",
    marketplace: "paved",
    fountain: "water",
    grave_yard: "green",
    school: "urban",
    university: "urban",
    college: "urban",
    hospital: "urban",
  },
  waterway: { riverbank: "water", dock: "water" },
  man_made: { pier: "paved", breakwater: "paved", groyne: "paved", quay: "paved", bridge: "paved" },
  aeroway: { apron: "paved" },
  place: { square: "paved" },
};

/** Carriageway widths in metres, by highway class. */
const ROADS: Record<string, number> = {
  motorway: 15,
  trunk: 13,
  primary: 11,
  secondary: 9.5,
  tertiary: 8.5,
  motorway_link: 7.5,
  trunk_link: 7,
  primary_link: 6.5,
  secondary_link: 6.5,
  tertiary_link: 6,
  unclassified: 6.5,
  residential: 6.5,
  living_street: 5.5,
  road: 6,
  busway: 6,
  raceway: 10,
  service: 3.6,
};

const PATHS: Record<string, number> = {
  pedestrian: 5.5,
  footway: 2,
  path: 1.7,
  cycleway: 2.2,
  steps: 2.4,
  track: 2.8,
  bridleway: 2,
};

const RAILS: Record<string, number> = {
  rail: 3.2,
  narrow_gauge: 2.4,
  light_rail: 2.6,
  tram: 2.2,
  funicular: 2.4,
  monorail: 2,
  subway: 3,
};

const WATERWAYS: Record<string, number> = {
  river: 12,
  canal: 8,
  tidal_channel: 6,
  stream: 2.6,
  drain: 1.6,
  ditch: 1.4,
};

const STILL_WATER = new Set(["lake", "pond", "reservoir", "basin", "lagoon", "oxbow", "reflecting_pool"]);

function parseMeters(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = value.replace(",", ".").match(/-?\d+(\.\d+)?/);
  if (!match) return undefined;
  let number = Number(match[0]);
  if (/ft|feet|'/.test(value)) number *= 0.3048;
  return Number.isFinite(number) ? number : undefined;
}

function isUnderground(tags: OsmTags): boolean {
  return (!!tags.tunnel && tags.tunnel !== "no") || tags.location === "underground";
}

function areaKind(tags: OsmTags): AreaKind | null {
  for (const key in AREA_RULES) {
    const value = tags[key];
    if (!value) continue;
    const kind = AREA_RULES[key]![value];
    if (!kind) continue;
    if (kind === "water" && key === "natural") {
      if (tags.water && STILL_WATER.has(tags.water)) return "lake";
      // Untagged water bodies are usually ponds and lakes; rivers and canals say so.
      if (!tags.water) return "lake";
    }
    return kind;
  }
  return null;
}

function classifyLine(tags: OsmTags, detail: Detail): Omit<LineFeature, "line"> | null {
  const bridge = !!tags.bridge && tags.bridge !== "no";
  const tagged = parseMeters(tags.width);
  const highway = tags.highway;
  if (highway) {
    if (isUnderground(tags)) return null;
    const road = ROADS[highway];
    if (road !== undefined) {
      if (highway === "service") {
        if (detail === 0) return null;
        if (detail === 1 && (tags.service === "parking_aisle" || tags.service === "driveway")) return null;
      }
      const lanes = Number(tags.lanes);
      let width = tagged ?? (lanes >= 3 ? Math.max(road, lanes * 3.3) : road);
      width = Math.min(40, Math.max(3, width));
      return { layer: "roads", width, bridge };
    }
    const path = PATHS[highway];
    if (path !== undefined) {
      if (highway !== "pedestrian" && detail === 0) return null;
      if (detail === 1 && (tags.footway === "sidewalk" || tags.footway === "crossing")) return null;
      return { layer: "paths", width: Math.min(12, Math.max(1.5, tagged ?? path)), bridge };
    }
    return null;
  }
  const railway = tags.railway;
  if (railway) {
    const width = RAILS[railway];
    if (width === undefined || isUnderground(tags)) return null;
    if (railway === "subway" && !bridge && tags.tunnel !== "no") return null;
    if (tags.service && detail < 2) return null;
    return { layer: "rail", width, bridge };
  }
  const waterway = tags.waterway;
  if (waterway) {
    const width = WATERWAYS[waterway];
    if (width === undefined || isUnderground(tags)) return null;
    if ((waterway === "drain" || waterway === "ditch") && detail === 0) return null;
    return { layer: "water", width: Math.min(60, Math.max(1.2, tagged ?? width)), bridge: false };
  }
  if (tags.man_made === "pier" || tags.man_made === "groyne" || tags.man_made === "breakwater") {
    return { layer: "paved", width: Math.min(20, Math.max(1.5, tagged ?? 3)), bridge: true };
  }
  if (tags.aeroway === "runway") return { layer: "roads", width: tagged ?? 40, bridge: false };
  if (tags.aeroway === "taxiway") return { layer: "roads", width: tagged ?? 18, bridge: false };
  if (tags.barrier === "city_wall") return { layer: "wall", width: 2.4, bridge: false };
  return null;
}

/** Joins way fragments end to end into closed rings. Fragments that never close are dropped. */
export function assembleRings(segments: Ring[]): Ring[] {
  const rings: Ring[] = [];
  const open: Ring[] = [];
  for (const segment of segments) {
    const n = segment.length;
    if (n < 4) continue;
    if (segment[0] === segment[n - 2] && segment[1] === segment[n - 1]) {
      if (n >= 8) rings.push(segment.slice(0, n - 2));
    } else {
      open.push(segment);
    }
  }
  if (!open.length) return rings;

  const key = (x: number, y: number) => `${x},${y}`;
  const ends = new Map<string, number[]>();
  open.forEach((segment, index) => {
    for (const k of [
      key(segment[0]!, segment[1]!),
      key(segment[segment.length - 2]!, segment[segment.length - 1]!),
    ]) {
      const list = ends.get(k);
      if (list) list.push(index);
      else ends.set(k, [index]);
    }
  });

  const used = new Uint8Array(open.length);
  for (let start = 0; start < open.length; start++) {
    if (used[start]) continue;
    used[start] = 1;
    const ring = open[start]!.slice();
    for (let guard = 0; guard < open.length; guard++) {
      const n = ring.length;
      if (ring[0] === ring[n - 2] && ring[1] === ring[n - 1]) break;
      const candidates = ends.get(key(ring[n - 2]!, ring[n - 1]!));
      const next = candidates?.find((index) => !used[index]);
      if (next === undefined) break;
      used[next] = 1;
      const segment = open[next]!;
      const m = segment.length;
      if (segment[0] === ring[n - 2] && segment[1] === ring[n - 1]) {
        for (let i = 2; i < m; i++) ring.push(segment[i]!);
      } else {
        for (let i = m - 4; i >= 0; i -= 2) ring.push(segment[i]!, segment[i + 1]!);
      }
    }
    const n = ring.length;
    if (n >= 8 && ring[0] === ring[n - 2] && ring[1] === ring[n - 1]) rings.push(ring.slice(0, n - 2));
  }
  return rings;
}

/**
 * Decodes the compact OSM payload into classified features in local metres, keeping only what
 * can touch the area box.
 */
export function readFeatures(
  payload: OsmPayload,
  projection: Projection,
  box: Box,
  detail: Detail,
): Features {
  const features: Features = {
    areas: [],
    lines: [],
    buildings: [],
    coastlines: [],
    trees: [],
    treeRows: [],
    timestamp: payload.timestamp,
  };
  const { origin } = payload;
  const decode = (g: number[]): Ring => {
    const out: Ring = new Array(g.length);
    for (let i = 0; i < g.length; i += 2) {
      const [x, y] = projection.toLocal(
        origin.lat + g[i]! / OSM_COORD_SCALE,
        origin.lon + g[i + 1]! / OSM_COORD_SCALE,
      );
      out[i] = x;
      out[i + 1] = y;
    }
    return out;
  };
  const near = (rings: Ring[]): boolean => rings.some((ring) => boxesOverlap(ringBox(ring), box));

  const addArea = (tags: OsmTags, rings: Ring[], id: number): void => {
    if (!rings.length || !near(rings)) return;
    if (tags.building && tags.building !== "no") {
      if (tags.location !== "underground") features.buildings.push({ id, tags, rings, part: false });
      return;
    }
    if (tags["building:part"] && tags["building:part"] !== "no") {
      features.buildings.push({ id, tags, rings, part: true });
      return;
    }
    if (tags.highway) {
      // Closed highways are squares only when mapped as areas; otherwise they are roundabouts.
      if (tags.area === "yes" || tags.type === "multipolygon") features.areas.push({ kind: "paved", rings });
      return;
    }
    const kind = areaKind(tags);
    if (!kind) return;
    if (kind === "urban" && detail === 0) return;
    if ((kind === "water" || kind === "lake") && (isUnderground(tags) || tags.covered === "yes")) return;
    features.areas.push({ kind, rings });
  };

  for (const way of payload.ways) {
    const { tags } = way;
    const points = decode(way.g);
    const n = points.length;
    const closed = n >= 8 && points[0] === points[n - 2] && points[1] === points[n - 1];

    if (tags.natural === "coastline") {
      features.coastlines.push(points);
      continue;
    }
    if (tags.natural === "tree_row") {
      if (boxesOverlap(ringBox(points), box)) {
        features.treeRows.push({ line: points, conifer: tags.leaf_type === "needleleaved" });
      }
      continue;
    }

    const isHighwayLine = !!tags.highway && tags.area !== "yes";
    const isLinear =
      isHighwayLine ||
      !!tags.railway ||
      (!!tags.waterway && !AREA_RULES.waterway![tags.waterway]) ||
      !!tags.barrier;
    if (closed && !isLinear) {
      addArea(tags, [points.slice(0, n - 2)], way.id);
      // Runways and piers can be mapped as outlines too; handled above as areas.
      continue;
    }
    const line = classifyLine(tags, detail);
    if (line && boxesOverlap(ringBox(points), box)) features.lines.push({ ...line, line: points });
  }

  for (const relation of payload.relations) {
    const rings = assembleRings(relation.members.map((member) => decode(member.g)));
    addArea({ ...relation.tags, type: "multipolygon" }, rings, -relation.id);
  }

  if (detail > 0) {
    for (const node of payload.nodes) {
      if (node.tags.natural !== "tree") continue;
      const [x, y] = projection.toLocal(
        origin.lat + node.p[0] / OSM_COORD_SCALE,
        origin.lon + node.p[1] / OSM_COORD_SCALE,
      );
      if (x < box.minX || x > box.maxX || y < box.minY || y > box.maxY) continue;
      features.trees.push({ x, y, conifer: node.tags.leaf_type === "needleleaved" });
    }
  }
  return features;
}

export { parseMeters };
