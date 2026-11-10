import type { Place } from "../../shared/types";
import { language } from "./i18n";

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json() as Promise<T>;
}

/** Search-as-you-type suggestions, biased towards the place currently on screen. */
export function suggestPlaces(
  query: string,
  near: { lat: number; lon: number },
  signal: AbortSignal,
): Promise<Place[]> {
  const params = new URLSearchParams({
    q: query,
    lang: language(),
    lat: near.lat.toFixed(3),
    lon: near.lon.toFixed(3),
  });
  return getJson(`/api/suggest?${params}`, signal);
}

/** Full geocoding of whatever the user typed. */
export function searchPlaces(query: string, signal?: AbortSignal): Promise<Place[]> {
  return getJson(`/api/geocode?${new URLSearchParams({ q: query, lang: language() })}`, signal);
}

/** Name of the place at the given coordinates, if any. */
export async function reverseGeocode(lat: number, lon: number, signal?: AbortSignal): Promise<Place | null> {
  const params = new URLSearchParams({ lat: lat.toFixed(5), lon: lon.toFixed(5), lang: language() });
  try {
    return await getJson<Place | null>(`/api/reverse?${params}`, signal);
  } catch {
    return null;
  }
}
