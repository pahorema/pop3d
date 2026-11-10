import { resolve } from "node:path";
import pkg from "../package.json";

const env = process.env;

function list(value: string | undefined, fallback: string[]): string[] {
  if (!value) return fallback;
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export const config = {
  version: pkg.version,
  port: Number(env.PORT ?? 3000),
  host: env.HOST ?? "0.0.0.0",
  dev: env.NODE_ENV !== "production",
  distDir: resolve(import.meta.dir, "../dist"),
  cacheDir: env.POP3D_CACHE_DIR ?? resolve(import.meta.dir, "../.cache"),
  cacheMaxBytes: Number(env.POP3D_CACHE_MAX_MB ?? 2048) * 1024 * 1024,
  /** Sent to upstream data providers. Override it to add contact details as their policies ask. */
  userAgent: env.POP3D_USER_AGENT ?? `pop3d/${pkg.version}`,
  overpassEndpoints: list(env.POP3D_OVERPASS, [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass.openstreetmap.fr/api/interpreter",
  ]),
  nominatim: env.POP3D_NOMINATIM ?? "https://nominatim.openstreetmap.org",
  photon: env.POP3D_PHOTON ?? "https://photon.komoot.io",
  demTiles: env.POP3D_DEM_TILES ?? "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png",
  /** Value of Access-Control-Allow-Origin for the API; an empty string keeps it same-origin. */
  cors: env.POP3D_CORS ?? "*",
  /** Largest side of a requested area, in metres. */
  maxSpan: Number(env.POP3D_MAX_SPAN ?? 6500),
} as const;
