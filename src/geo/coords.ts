export interface LatLon {
  lat: number;
  lon: number;
}

const NUMBER = String.raw`[-+]?\d+(?:[.,]\d+)?`;

function valid(lat: number, lon: number): LatLon | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

function toNumber(text: string): number {
  return Number(text.replace(",", "."));
}

/** Degrees, minutes, seconds with an optional hemisphere letter on either side. */
function parseDms(text: string): { value: number; axis: "lat" | "lon" | null } | null {
  const match = text
    .trim()
    .match(
      /^([NSEWO])?\s*([-+]?\d+(?:[.,]\d+)?)\s*(?:[°º:d]\s*)?(?:(\d+(?:[.,]\d+)?)\s*(?:['′m:]\s*|\s+))?(?:(\d+(?:[.,]\d+)?)\s*(?:"|″|''|s)?\s*)?([NSEWO])?$/i,
    );
  if (!match) return null;
  const letter = (match[1] ?? match[5] ?? "").toUpperCase();
  const degrees = toNumber(match[2]!);
  const minutes = match[3] ? toNumber(match[3]) : 0;
  const seconds = match[4] ? toNumber(match[4]) : 0;
  if (minutes >= 60 || seconds >= 60) return null;
  let value = Math.abs(degrees) + minutes / 60 + seconds / 3600;
  if (degrees < 0 || letter === "S" || letter === "W" || letter === "O") value = -value;
  // "O" is west in Italian, Spanish and French (ovest, oeste, ouest).
  const axis = letter === "N" || letter === "S" ? "lat" : letter ? "lon" : null;
  return { value, axis };
}

/**
 * Understands the ways people write coordinates: decimal degrees with dots or commas,
 * degrees/minutes/seconds, hemisphere letters, `geo:` URIs and map links.
 * Returns `null` when the text is not a coordinate pair.
 */
export function parseCoordinates(input: string): LatLon | null {
  const text = input.trim();
  if (!text || text.length > 200) return null;

  // Links from the usual map sites.
  const at = text.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (at) return valid(Number(at[1]), Number(at[2]));
  const hashMap = text.match(/#map=\d+(?:\.\d+)?\/(-?\d+\.\d+)\/(-?\d+\.\d+)/);
  if (hashMap) return valid(Number(hashMap[1]), Number(hashMap[2]));
  const queryPair = text.match(/[?&](?:q|ll|query|center)=(-?\d+\.\d+)(?:,|%2C)(-?\d+\.\d+)/i);
  if (queryPair) return valid(Number(queryPair[1]), Number(queryPair[2]));
  const mlat = text.match(/mlat=(-?\d+\.\d+)/);
  const mlon = text.match(/mlon=(-?\d+\.\d+)/);
  if (mlat && mlon) return valid(Number(mlat[1]), Number(mlon[1]));
  if (/^https?:\/\//i.test(text)) return null;

  const geo = text.match(/^geo:(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/i);
  if (geo) return valid(Number(geo[1]), Number(geo[2]));

  const cleaned = text.replace(/\b(lat(?:itude|itudine)?|lon(?:g|gitude|gitudine)?)\b\s*[:=]?/gi, " ").trim();

  // Plain decimals: "45.65, 13.77", "45.65 13.77", "45,65; 13,77", "45,65, 13,77".
  const pair =
    cleaned.match(new RegExp(String.raw`^(${NUMBER})\s*[;/|]\s*(${NUMBER})$`)) ??
    cleaned.match(/^([-+]?\d+(?:\.\d+)?)\s*[,\s]\s*([-+]?\d+(?:\.\d+)?)$/) ??
    cleaned.match(/^([-+]?\d+,\d+)\s*[,\s]\s*([-+]?\d+,\d+)$/);
  if (pair) return valid(toNumber(pair[1]!), toNumber(pair[2]!));

  // Anything with degree signs or hemisphere letters: split in two halves and parse each.
  if (!/[°º'′"″NSEWO]/i.test(cleaned)) return null;
  const candidates: [string, string][] = [];
  const separator = cleaned.match(/^(.+?)\s*[,;/|]\s+(.+)$/) ?? cleaned.match(/^(.+?)\s*[;/|]\s*(.+)$/);
  if (separator) candidates.push([separator[1]!, separator[2]!]);
  const letterSplit =
    cleaned.match(/^(.*?[NS])\s*,?\s*(.*?[EWO])$/i) ?? cleaned.match(/^([NS].*?)\s*,?\s*([EWO].*)$/i);
  if (letterSplit) candidates.push([letterSplit[1]!, letterSplit[2]!]);
  const reversed =
    cleaned.match(/^(.*?[EWO])\s*,?\s*(.*?[NS])$/i) ?? cleaned.match(/^([EWO].*?)\s*,?\s*([NS].*)$/i);
  if (reversed) candidates.push([reversed[1]!, reversed[2]!]);
  const spaced = cleaned.match(/^(\S+)\s+(\S+)$/);
  if (spaced) candidates.push([spaced[1]!, spaced[2]!]);

  for (const [first, second] of candidates) {
    const a = parseDms(first);
    const b = parseDms(second);
    if (!a || !b) continue;
    if (a.axis === "lon" && b.axis !== "lon") return valid(b.value, a.value);
    if (a.axis === b.axis && a.axis !== null) continue;
    return valid(a.value, b.value);
  }
  return null;
}

/** "45.6503° N, 13.7678° E" */
export function formatCoordinates({ lat, lon }: LatLon, digits = 4): string {
  const ns = lat >= 0 ? "N" : "S";
  const ew = lon >= 0 ? "E" : "W";
  return `${Math.abs(lat).toFixed(digits)}° ${ns}  ${Math.abs(lon).toFixed(digits)}° ${ew}`;
}
