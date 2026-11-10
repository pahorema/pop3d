import {
  OSM_COORD_SCALE,
  type OsmNode,
  type OsmPayload,
  type OsmRelation,
  type OsmTags,
  type OsmWay,
} from "../shared/types";
import type { Bytes, DiskCache } from "./cache";
import { config } from "./config";
import { type BBox, HttpError, upstream } from "./http";

const DAY = 86_400_000;
/** How long we wait for one mirror before also asking the next one. */
const HEDGE_DELAY_MS = 2500;
const ATTEMPT_TIMEOUT_MS = 80_000;
const MAX_CONCURRENT = 3;

/** Tags the renderer reads; everything else is dropped to keep payloads small. */
const KEPT_TAGS = new Set([
  "aeroway",
  "amenity",
  "area",
  "barrier",
  "bridge",
  "building",
  "building:colour",
  "building:levels",
  "building:material",
  "building:min_level",
  "building:part",
  "covered",
  "golf",
  "height",
  "highway",
  "intermittent",
  "landuse",
  "lanes",
  "layer",
  "leaf_type",
  "leisure",
  "location",
  "man_made",
  "min_height",
  "name",
  "natural",
  "place",
  "railway",
  "roof:colour",
  "roof:direction",
  "roof:height",
  "roof:levels",
  "roof:orientation",
  "roof:shape",
  "service",
  "sport",
  "surface",
  "tourism",
  "tunnel",
  "water",
  "waterway",
  "wetland",
  "width",
  "addr:street",
  "addr:housenumber",
]);

const NATURAL = "water|wood|scrub|grassland|heath|beach|sand|bare_rock|scree|shingle|wetland|glacier|fell";
const LANDUSE =
  "forest|grass|meadow|farmland|orchard|vineyard|allotments|village_green|recreation_ground|cemetery|" +
  "residential|commercial|retail|industrial|railway|quarry|basin|reservoir|salt_pond|flowerbed|" +
  "plant_nursery|greenhouse_horticulture|farmyard|construction|brownfield|religious|education";
const LEISURE =
  "park|garden|pitch|playground|golf_course|sports_centre|stadium|track|swimming_pool|common|dog_park|" +
  "marina|recreation_ground|miniature_golf";
const AMENITY = "parking|fountain|school|university|college|hospital|grave_yard|marketplace";

export function buildQuery({ s, w, n, e }: BBox): string {
  const bbox = [s, w, n, e].map((v) => v.toFixed(6)).join(",");
  return `[out:json][timeout:60][maxsize:536870912][bbox:${bbox}];
(
  way["building"];
  way["building:part"];
  way["highway"];
  way["railway"~"^(rail|tram|light_rail|narrow_gauge|funicular|monorail|subway)$"];
  way["waterway"~"^(river|stream|canal|drain|ditch|riverbank|dock|tidal_channel)$"];
  way["natural"~"^(${NATURAL}|coastline|tree_row)$"];
  way["landuse"~"^(${LANDUSE})$"];
  way["leisure"~"^(${LEISURE})$"];
  way["amenity"~"^(${AMENITY})$"];
  way["man_made"~"^(pier|breakwater|groyne|bridge|quay)$"];
  way["aeroway"~"^(runway|taxiway|apron)$"];
  way["barrier"~"^(wall|city_wall|hedge|retaining_wall)$"];
  way["place"="square"];
)->.w;
(
  relation["type"="multipolygon"]["building"];
  relation["type"="multipolygon"]["building:part"];
  relation["type"="multipolygon"]["natural"~"^(${NATURAL})$"];
  relation["type"="multipolygon"]["landuse"~"^(${LANDUSE})$"];
  relation["type"="multipolygon"]["leisure"~"^(${LEISURE})$"];
  relation["type"="multipolygon"]["waterway"~"^(riverbank|dock)$"];
  relation["type"="multipolygon"]["highway"~"^(pedestrian|footway|service)$"];
  relation["type"="multipolygon"]["amenity"~"^(${AMENITY})$"];
  relation["type"="multipolygon"]["place"="square"];
)->.r;
node["natural"="tree"]->.n;
.w out tags geom qt;
.r out body geom qt;
.n out body qt;`;
}

function keepTags(tags: Record<string, string> | undefined): OsmTags {
  const out: OsmTags = {};
  if (!tags) return out;
  for (const key in tags) if (KEPT_TAGS.has(key)) out[key] = tags[key]!;
  return out;
}

/** Shrinks a raw Overpass response into the compact payload the client consumes. */
export function compactOverpass(raw: any, bbox: BBox): OsmPayload {
  const origin = { lat: bbox.s, lon: bbox.w };
  const flatten = (geometry: ({ lat: number; lon: number } | null)[] | undefined): number[] => {
    const out: number[] = [];
    if (!geometry) return out;
    for (const point of geometry) {
      if (!point) continue;
      out.push(
        Math.round((point.lat - origin.lat) * OSM_COORD_SCALE),
        Math.round((point.lon - origin.lon) * OSM_COORD_SCALE),
      );
    }
    return out;
  };

  const nodes: OsmNode[] = [];
  const ways: OsmWay[] = [];
  const relations: OsmRelation[] = [];
  for (const element of raw.elements ?? []) {
    if (element.type === "way") {
      const g = flatten(element.geometry);
      if (g.length >= 4) ways.push({ id: element.id, tags: keepTags(element.tags), g });
    } else if (element.type === "relation") {
      const members = [];
      for (const member of element.members ?? []) {
        if (member.type !== "way") continue;
        const g = flatten(member.geometry);
        if (g.length >= 4) members.push({ role: member.role || "outer", g });
      }
      if (members.length) relations.push({ id: element.id, tags: keepTags(element.tags), members });
    } else if (element.type === "node" && Number.isFinite(element.lat)) {
      nodes.push({
        id: element.id,
        tags: keepTags(element.tags),
        p: [
          Math.round((element.lat - origin.lat) * OSM_COORD_SCALE),
          Math.round((element.lon - origin.lon) * OSM_COORD_SCALE),
        ],
      });
    }
  }
  return { v: 1, timestamp: raw.osm3s?.timestamp_osm_base ?? "", origin, nodes, ways, relations };
}

async function attempt(endpoint: string, query: string, signal: AbortSignal): Promise<any> {
  const response = await upstream(endpoint, {
    method: "POST",
    body: new URLSearchParams({ data: query }),
    timeoutMs: ATTEMPT_TIMEOUT_MS,
    signal,
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const text = await response.text();
  if (!text.startsWith("{")) throw new Error("unexpected non-JSON answer");
  // Overpass reports timeouts and memory errors with a 200 status and a trailing "remark".
  const tail = text.slice(-600);
  const remark = tail.match(/"remark"\s*:\s*"([^"]*)"/)?.[1];
  if (remark && /error|timed out|out of memory/i.test(remark)) throw new Error(remark.slice(0, 140));
  return JSON.parse(text);
}

let preferred = 0;

/**
 * Asks the mirrors for the same data with staggered ("hedged") requests: the favourite
 * mirror goes first and the others join only if it is slow or fails. First valid answer wins.
 */
function hedged(query: string): Promise<any> {
  const endpoints = config.overpassEndpoints.map((_, i, all) => all[(i + preferred) % all.length] as string);
  const controller = new AbortController();
  const errors: string[] = [];
  return new Promise((resolve, reject) => {
    let started = 0;
    let pending = 0;
    let settled = false;
    let timer: ReturnType<typeof setInterval> | undefined;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      fn();
      controller.abort();
    };

    const startNext = () => {
      if (settled || started >= endpoints.length) return;
      const endpoint = endpoints[started++]!;
      const host = new URL(endpoint).host;
      const began = Date.now();
      pending++;
      attempt(endpoint, query, controller.signal).then(
        (data) => {
          finish(() => {
            preferred = config.overpassEndpoints.indexOf(endpoint);
            console.log(`[overpass] ${host} answered in ${Date.now() - began} ms`);
            resolve(data);
          });
        },
        (error: Error) => {
          pending--;
          if (settled) return;
          errors.push(`${host}: ${error.message}`);
          if (started < endpoints.length) startNext();
          else if (pending === 0) {
            finish(() =>
              reject(new HttpError(502, `OpenStreetMap data unavailable (${errors.join("; ")})`, "upstream")),
            );
          }
        },
      );
    };

    startNext();
    timer = setInterval(startNext, HEDGE_DELAY_MS);
  });
}

let active = 0;
const waiting: (() => void)[] = [];

async function withSlot<T>(task: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT) await new Promise<void>((resolve) => waiting.push(resolve));
  active++;
  try {
    return await task();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

/** Returns the gzip-compressed compact OSM payload for the area, from cache when possible. */
export async function osmExtract(cache: DiskCache, bbox: BBox): Promise<{ data: Bytes; fresh: boolean }> {
  const key = `v2|${[bbox.s, bbox.w, bbox.n, bbox.e].map((v) => v.toFixed(5)).join(",")}`;
  const produce = () =>
    withSlot(async () => {
      const raw = await hedged(buildQuery(bbox));
      const payload = compactOverpass(raw, bbox);
      return Bun.gzipSync(new TextEncoder().encode(JSON.stringify(payload)));
    });
  // The map changes slowly: an old extract shown at once beats a fresh one after a long wait.
  return cache.wrap("osm", key, 14 * DAY, produce, { serveStale: true });
}
