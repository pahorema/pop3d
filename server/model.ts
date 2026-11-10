import {
  MODEL_BUILDING_COLORS,
  MODEL_DEFAULTS,
  MODEL_FORMATS,
  MODEL_LIMITS,
  MODEL_SHAPES,
  type ModelFormat,
  type ModelOptions,
  modelQuery,
} from "../shared/model-api";
import { type Detail, LAYERS, type LayerId } from "../src/core/types";
import { MODEL_COPYRIGHT } from "../src/export/mesh";
import { areaBounds } from "../src/geo/projection";
import { COLOR_KEYS, type ColorKey, THEMES } from "../src/scene/themes";
import { GRID_PAD, gridCells } from "../src/worker/build";
import type { Bytes, DiskCache } from "./cache";
import { config } from "./config";
import { elevationGrid } from "./dem";
import { search } from "./geocode";
import { HttpError } from "./http";
import type { ModelJob, ModelMeta, ModelReply } from "./model-build";
import { osmExtract } from "./overpass";

const DAY = 86_400_000;
/** Bump when the generated geometry changes, so that cached models are rebuilt. */
const MODEL_VERSION = 1;
const MAX_WAITING = 8;
const JOB_TIMEOUT_MS = 120_000;

const CONTENT_TYPES: Record<ModelFormat, string> = {
  glb: "model/gltf-binary",
  obj: "application/zip",
  stl: "model/stl",
  "3mf": "model/3mf",
  json: "application/json; charset=utf-8",
};

const EXTENSIONS: Record<ModelFormat, string> = {
  glb: ".glb",
  obj: "-obj.zip",
  stl: ".stl",
  "3mf": ".3mf",
  json: ".json",
};

// ---- Parameters ------------------------------------------------------------------------------

function bad(name: string, expected: string): never {
  throw new HttpError(400, `Invalid parameter "${name}": expected ${expected}`, "bad_request");
}

function number(query: URLSearchParams, name: string, min: number, max: number): number | undefined {
  const raw = query.get(name);
  if (raw === null || raw.trim() === "") return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) bad(name, `a number from ${min} to ${max}`);
  return value;
}

function choice<T extends string>(query: URLSearchParams, name: string, values: readonly T[]): T | undefined {
  const raw = query.get(name);
  if (raw === null || raw === "") return undefined;
  if (!values.includes(raw as T)) bad(name, `one of ${values.join(", ")}`);
  return raw as T;
}

function flag(query: URLSearchParams, name: string): boolean | undefined {
  const raw = query.get(name)?.toLowerCase();
  if (raw === undefined || raw === "") return undefined;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return bad(name, "true or false");
}

function layerList(query: URLSearchParams, name: string): LayerId[] | undefined {
  const raw = query.get(name);
  if (raw === null || raw.trim() === "") return undefined;
  const layers = raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  for (const layer of layers) {
    if (!(LAYERS as readonly string[]).includes(layer)) bad(name, `layer names among ${LAYERS.join(", ")}`);
  }
  return [...new Set(layers)] as LayerId[];
}

/** Reads and validates every option of a model request. */
export function parseModelOptions(query: URLSearchParams): ModelOptions {
  const d = MODEL_DEFAULTS;
  const [minSize, maxSize] = MODEL_LIMITS.size;
  const size = number(query, "size", minSize, maxSize);
  const width = number(query, "width", minSize, maxSize) ?? size ?? d.width;
  const depth = number(query, "depth", minSize, maxSize) ?? size ?? (query.has("width") ? width : d.depth);

  const lat = number(query, "lat", -85, 85);
  const lon = number(query, "lon", -180, 180);
  if ((lat === undefined) !== (lon === undefined)) bad(lat === undefined ? "lat" : "lon", "both lat and lon");
  const q = query.get("q")?.trim().slice(0, 200) || undefined;
  if (lat === undefined && !q) {
    throw new HttpError(400, 'Say where: give "lat" and "lon", or a place name in "q"', "bad_request");
  }

  const colors: Partial<Record<ColorKey, string>> = {};
  for (const pair of (query.get("colors") ?? "").split(",")) {
    if (!pair.trim()) continue;
    const [key, value] = pair.split(":").map((part) => part.trim());
    if (!COLOR_KEYS.includes(key as ColorKey)) bad("colors", `keys among ${COLOR_KEYS.join(", ")}`);
    if (!value || !/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value))
      bad("colors", "hex colours such as walls:f2e9dc");
    const hex = value!.replace("#", "").toLowerCase();
    colors[key as ColorKey] = `#${hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex}`;
  }

  const detail = choice(query, "detail", ["0", "1", "2"]);
  return {
    q: lat === undefined ? q : undefined,
    lat,
    lon,
    shape: choice(query, "shape", MODEL_SHAPES) ?? d.shape,
    width: Math.round(width),
    depth: Math.round(depth),
    detail: detail === undefined ? d.detail : (Number(detail) as Detail),
    relief: Math.round((number(query, "relief", ...MODEL_LIMITS.relief) ?? d.relief) * 100) / 100,
    roofs: flag(query, "roofs") ?? d.roofs,
    format: choice(query, "format", MODEL_FORMATS) ?? d.format,
    theme:
      choice(
        query,
        "theme",
        THEMES.map((theme) => theme.id),
      ) ?? d.theme,
    colors,
    buildings: choice(query, "buildings", MODEL_BUILDING_COLORS) ?? d.buildings,
    layers: layerList(query, "layers") ?? null,
    hide: layerList(query, "hide") ?? [],
    printSize: number(query, "print_size", ...MODEL_LIMITS.printSize) ?? d.printSize,
    printBase: number(query, "print_base", ...MODEL_LIMITS.printBase) ?? d.printBase,
    printZScale: number(query, "print_zscale", ...MODEL_LIMITS.printZScale) ?? d.printZScale,
    printFeature: number(query, "print_feature", ...MODEL_LIMITS.printFeature) ?? d.printFeature,
    lang: choice(query, "lang", ["it", "en"] as const) ?? d.lang,
    download: flag(query, "download") ?? d.download,
  };
}

// ---- Worker pool -----------------------------------------------------------------------------

interface Pending {
  job: ModelJob;
  resolve(result: { meta: ModelMeta; body: Bytes }): void;
  reject(error: Error): void;
}

/**
 * Builds models off the main thread, one at a time, so that a heavy request never stalls the
 * rest of the server. A stuck build is abandoned and its worker replaced.
 */
class ModelBuilder {
  private worker: Worker | null = null;
  private waiting: Pending[] = [];
  private current: Pending | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private nextId = 1;

  run(job: Omit<ModelJob, "id">): Promise<{ meta: ModelMeta; body: Bytes }> {
    if (this.waiting.length >= MAX_WAITING) {
      throw new HttpError(503, "Too many models are being built right now, try again shortly", "busy");
    }
    return new Promise((resolve, reject) => {
      this.waiting.push({ job: { ...job, id: this.nextId++ }, resolve, reject });
      this.next();
    });
  }

  private next(): void {
    if (this.current) return;
    const pending = this.waiting.shift();
    if (!pending) return;
    this.current = pending;
    if (!this.worker) {
      this.worker = new Worker(new URL("./model-worker.ts", import.meta.url).href);
      this.worker.onmessage = (event: MessageEvent<ModelReply>) => this.settle(event.data);
      this.worker.onerror = (event) => this.fail(new Error(event.message || "model worker crashed"));
    }
    this.timer = setTimeout(() => this.fail(new Error("model build timed out")), JOB_TIMEOUT_MS);
    this.worker.postMessage(pending.job);
  }

  private settle(reply: ModelReply): void {
    const pending = this.current;
    if (!pending || pending.job.id !== reply.id) return;
    clearTimeout(this.timer);
    this.current = null;
    if (reply.ok) pending.resolve({ meta: reply.meta, body: reply.body });
    else pending.reject(new HttpError(500, `Could not build the model: ${reply.message}`, "build_failed"));
    this.next();
  }

  private fail(error: Error): void {
    clearTimeout(this.timer);
    this.worker?.terminate();
    this.worker = null;
    const pending = this.current;
    this.current = null;
    pending?.reject(new HttpError(500, `Could not build the model: ${error.message}`, "build_failed"));
    this.next();
  }
}

const builder = new ModelBuilder();

// ---- Cache packing ---------------------------------------------------------------------------

/** Stores the metadata in front of the file: 4-byte length, JSON, payload. */
function pack(meta: ModelMeta, body: Bytes): Bytes {
  const header = new TextEncoder().encode(JSON.stringify(meta));
  const out = new Uint8Array(4 + header.length + body.length);
  new DataView(out.buffer).setUint32(0, header.length, true);
  out.set(header, 4);
  out.set(body, 4 + header.length);
  return out;
}

function unpack(packed: Bytes): { meta: ModelMeta; body: Bytes } {
  const length = new DataView(packed.buffer, packed.byteOffset).getUint32(0, true);
  const meta = JSON.parse(new TextDecoder().decode(packed.subarray(4, 4 + length))) as ModelMeta;
  return { meta, body: packed.subarray(4 + length) as Bytes };
}

// ---- Request handling ------------------------------------------------------------------------

function slugify(text: string): string {
  const slug = text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `pop3d-${slug || "model"}`;
}

/** Answers `/api/model`: resolves the place, builds (or reuses) the model, returns the file. */
export async function modelResponse(cache: DiskCache, url: URL): Promise<Response> {
  const options = parseModelOptions(url.searchParams);
  if (Math.max(options.width, options.depth) + 60 > config.maxSpan) {
    throw new HttpError(413, "Area too large", "too_large");
  }

  let place: { name: string; detail: string } | null = null;
  let { lat, lon } = options;
  if (lat === undefined || lon === undefined) {
    const [found] = await search(cache, options.q!, options.lang);
    if (!found) throw new HttpError(404, `No place found for "${options.q}"`, "not_found");
    lat = Math.round(found.lat * 1e5) / 1e5;
    lon = Math.round(found.lon * 1e5) / 1e5;
    place = { name: found.name, detail: found.detail };
  }
  const resolved = { ...options, q: undefined, lat, lon };
  const title = place?.name ?? `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
  const slug = slugify(place?.name ?? `${lat.toFixed(4)}-${lon.toFixed(4)}`);

  // Everything that changes the bytes goes into the key; how they are delivered does not.
  const { download: _download, q: _q, ...keyed } = resolved;
  const key = `v${MODEL_VERSION}|${config.version}|${JSON.stringify(keyed)}|${title}`;
  const { data, fresh } = await cache.wrap("model", key, 7 * DAY, async () => {
    const area = { lat, lon, shape: resolved.shape, width: resolved.width, depth: resolved.depth };
    const round = (value: number) => Number(value.toFixed(5));
    const b = areaBounds(area, 25);
    const osm = await osmExtract(cache, { s: round(b.s), w: round(b.w), n: round(b.n), e: round(b.e) });
    let elevation: Bytes | null = null;
    if (resolved.relief > 0) {
      const params = { area, detail: resolved.detail, relief: resolved.relief, roofs: resolved.roofs };
      try {
        elevation = await elevationGrid(cache, areaBounds(area, GRID_PAD), gridCells(params) + 1);
      } catch (error) {
        // Same choice as the app: a flat model beats no model.
        console.warn("[model] elevation unavailable, building flat:", (error as Error).message);
      }
    }
    const result = await builder.run({ options: resolved, title, slug, osm: osm.data, elevation });
    console.log(
      `[model] ${title} ${resolved.format} ${resolved.width}x${resolved.depth} m: ${result.meta.triangles} triangles in ${result.meta.buildMs} ms`,
    );
    return pack(result.meta, result.body);
  });
  const { meta, body } = unpack(data);

  const headers: Record<string, string> = {
    "content-type": CONTENT_TYPES[resolved.format],
    "cache-control": "public, max-age=86400",
    "x-cache": fresh ? "miss" : "hit",
    "x-pop3d-center": `${lat},${lon}`,
    "x-pop3d-triangles": String(meta.triangles),
    "x-pop3d-attribution": encodeURIComponent(MODEL_COPYRIGHT),
  };
  if (place) headers["x-pop3d-place"] = encodeURIComponent(place.name);
  if (meta.print) headers["x-pop3d-print-scale"] = `1:${meta.print.ratio}`;

  if (resolved.format === "json") {
    const base = { ...resolved, download: false };
    const formats: Record<string, string> = {};
    for (const format of MODEL_FORMATS) formats[format] = `/api/model?${modelQuery({ ...base, format })}`;
    const info = {
      place,
      center: { lat, lon },
      area: { shape: resolved.shape, width: resolved.width, depth: resolved.depth },
      options: {
        detail: resolved.detail,
        relief: resolved.relief,
        roofs: resolved.roofs,
        theme: resolved.theme,
        buildings: resolved.buildings,
        colors: resolved.colors,
        layers: resolved.layers,
        hide: resolved.hide,
      },
      model: {
        units: "metres",
        axes: "x east, y up, z south; origin at the centre of the area, y = 0 at its lowest ground",
        bottom: Math.round(meta.bottom * 100) / 100,
        top: Math.round(meta.top * 100) / 100,
        groundTop: Math.round(meta.groundTop * 100) / 100,
        triangles: meta.triangles,
        layers: meta.layers,
      },
      stats: meta.stats,
      formats,
      attribution: MODEL_COPYRIGHT,
    };
    return new Response(JSON.stringify(info, null, 2), { headers });
  }

  const disposition = resolved.download ? "attachment" : "inline";
  headers["content-disposition"] = `${disposition}; filename="${slug}${EXTENSIONS[resolved.format]}"`;
  headers["content-length"] = String(body.length);
  return new Response(body, { headers });
}
