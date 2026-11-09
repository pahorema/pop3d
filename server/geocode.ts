import type { Place } from "../shared/types";
import type { DiskCache } from "./cache";
import { config } from "./config";
import { HttpError, Throttle, upstream } from "./http";

const DAY = 86_400_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Nominatim's usage policy allows at most one request per second.
const nominatimThrottle = new Throttle(1100);
const PHOTON_LANGS = new Set(["en", "de", "fr"]);

function compact(parts: (string | undefined | null | false)[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of parts) {
    if (!part) continue;
    const text = part.trim();
    if (!text || seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    out.push(text);
  }
  return out.join(", ");
}

function spanFromExtent(south: number, west: number, north: number, east: number): number | undefined {
  if (![south, west, north, east].every(Number.isFinite)) return undefined;
  const height = Math.abs(north - south) * 111_320;
  const width = Math.abs(east - west) * 111_320 * Math.cos((((south + north) / 2) * Math.PI) / 180);
  const span = Math.max(width, height);
  return span > 0 ? Math.round(span) : undefined;
}

function fromNominatim(r: any): Place | null {
  const lat = Number(r.lat);
  const lon = Number(r.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const a = r.address ?? {};
  const locality = a.city ?? a.town ?? a.village ?? a.municipality ?? a.hamlet ?? a.suburb ?? a.county;
  const street = a.road ?? a.pedestrian ?? a.footway ?? a.square;
  const address = street && a.house_number ? `${street} ${a.house_number}` : street;
  const kind: string = r.addresstype ?? r.type ?? r.category ?? "place";
  let name: string = r.name ?? "";
  if (kind === "postcode" && a.postcode) name = compact([a.postcode, locality]).replace(",", "");
  if (!name) name = address ?? String(r.display_name ?? "").split(",")[0] ?? "";
  const detail = compact([
    address !== name && address,
    kind !== "postcode" && locality !== name && compact([a.postcode, locality]).replace(",", ""),
    a.state ?? a.region,
    a.country,
  ]);
  const box = (r.boundingbox ?? []).map(Number);
  return {
    id: `n${r.osm_type?.[0] ?? ""}${r.osm_id ?? r.place_id}`,
    name: name.trim() || detail,
    detail,
    lat,
    lon,
    kind,
    span: box.length === 4 ? spanFromExtent(box[0], box[2], box[1], box[3]) : undefined,
  };
}

function fromPhoton(feature: any): Place | null {
  const [lon, lat] = feature?.geometry?.coordinates ?? [];
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const p = feature.properties ?? {};
  const address = p.street && p.housenumber ? `${p.street} ${p.housenumber}` : p.street;
  const locality = p.city ?? p.town ?? p.village ?? p.district ?? p.county;
  const name: string = p.name ?? address ?? locality ?? "";
  const detail = compact([
    address !== name && address,
    locality !== name && compact([p.postcode, locality]).replace(",", ""),
    p.state,
    p.country,
  ]);
  const extent: number[] | undefined = p.extent;
  return {
    id: `p${p.osm_type ?? ""}${p.osm_id ?? `${lat},${lon}`}`,
    name: name.trim() || detail,
    detail,
    lat,
    lon,
    kind: p.type ?? p.osm_value ?? "place",
    span: extent?.length === 4 ? spanFromExtent(extent[3]!, extent[0]!, extent[1]!, extent[2]!) : undefined,
  };
}

function dedupe(places: (Place | null)[]): Place[] {
  const seen = new Set<string>();
  const out: Place[] = [];
  for (const place of places) {
    if (!place) continue;
    const key = `${place.name}|${place.lat.toFixed(3)},${place.lon.toFixed(3)}`;
    if (seen.has(key) || seen.has(place.id)) continue;
    seen.add(key);
    seen.add(place.id);
    out.push(place);
  }
  return out;
}

async function cachedJson<T>(
  cache: DiskCache,
  namespace: string,
  key: string,
  maxAge: number,
  produce: () => Promise<T>,
): Promise<T> {
  const { data } = await cache.wrap(namespace, key, maxAge, async () =>
    encoder.encode(JSON.stringify(await produce())),
  );
  return JSON.parse(decoder.decode(data)) as T;
}

/** Search-as-you-type suggestions (Photon is built for it, Nominatim forbids it). */
export function suggest(
  cache: DiskCache,
  query: string,
  lang: string,
  bias?: { lat: number; lon: number },
): Promise<Place[]> {
  const q = query.trim().slice(0, 200);
  const near = bias ? `${bias.lat.toFixed(1)},${bias.lon.toFixed(1)}` : "";
  return cachedJson(cache, "suggest", `${lang}|${near}|${q.toLowerCase()}`, 14 * DAY, async () => {
    const url = new URL("/api/", config.photon);
    url.searchParams.set("q", q);
    url.searchParams.set("limit", "7");
    if (PHOTON_LANGS.has(lang)) url.searchParams.set("lang", lang);
    if (bias) {
      url.searchParams.set("lat", bias.lat.toFixed(4));
      url.searchParams.set("lon", bias.lon.toFixed(4));
    }
    const response = await upstream(url.toString(), { timeoutMs: 8000 });
    if (!response.ok) throw new HttpError(502, `Suggestion service answered ${response.status}`, "upstream");
    const body = (await response.json()) as any;
    return dedupe((body.features ?? []).map(fromPhoton));
  });
}

/** Full forward geocoding: addresses, postcodes, place names. */
export function search(cache: DiskCache, query: string, lang: string): Promise<Place[]> {
  const q = query.trim().slice(0, 300);
  return cachedJson(cache, "search", `${lang}|${q.toLowerCase()}`, 30 * DAY, async () => {
    const url = new URL("/search", config.nominatim);
    url.searchParams.set("q", q);
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("limit", "8");
    url.searchParams.set("addressdetails", "1");
    url.searchParams.set("accept-language", lang);
    try {
      const response = await nominatimThrottle.run(() => upstream(url.toString(), { timeoutMs: 12_000 }));
      if (!response.ok) throw new Error(`status ${response.status}`);
      return dedupe(((await response.json()) as any[]).map(fromNominatim));
    } catch (error) {
      // Fall back to Photon so a Nominatim hiccup does not break the search box.
      console.warn("[geocode] nominatim failed, using photon:", (error as Error).message);
      return suggest(cache, q, lang);
    }
  });
}

/** Name of whatever sits at the given coordinates. */
export function reverse(cache: DiskCache, lat: number, lon: number, lang: string): Promise<Place | null> {
  const key = `${lang}|${lat.toFixed(4)},${lon.toFixed(4)}`;
  return cachedJson(cache, "reverse", key, 30 * DAY, async () => {
    const url = new URL("/reverse", config.nominatim);
    url.searchParams.set("lat", lat.toFixed(6));
    url.searchParams.set("lon", lon.toFixed(6));
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("zoom", "16");
    url.searchParams.set("addressdetails", "1");
    url.searchParams.set("accept-language", lang);
    const response = await nominatimThrottle.run(() => upstream(url.toString(), { timeoutMs: 12_000 }));
    if (!response.ok) throw new HttpError(502, `Geocoder answered ${response.status}`, "upstream");
    const body = (await response.json()) as any;
    if (body?.error) return null;
    const place = fromNominatim(body);
    return place ? { ...place, lat, lon } : null;
  });
}
