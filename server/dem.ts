import { decode } from "fast-png";
import { DEM_HEADER_BYTES, DEM_MAGIC } from "../shared/types";
import type { Bytes, DiskCache } from "./cache";
import { config } from "./config";
import { type BBox, HttpError, upstream } from "./http";

const TILE = 256;
const MAX_ZOOM = 15;
const MAX_TILES = 36;

type Tile = Float32Array;

/** Small in-memory cache of decoded tiles, on top of the PNG disk cache. */
const decoded = new Map<string, Promise<Tile>>();

function remember(key: string, tile: Promise<Tile>): Promise<Tile> {
  decoded.set(key, tile);
  if (decoded.size > 96) decoded.delete(decoded.keys().next().value as string);
  tile.catch(() => decoded.delete(key));
  return tile;
}

/** Decodes a Terrarium PNG: elevation = R * 256 + G + B / 256 - 32768 metres. */
function decodeTerrarium(png: Uint8Array): Tile {
  const image = decode(png);
  const { width, height, channels, data } = image;
  if (width !== TILE || height !== TILE || channels < 3) throw new Error("unexpected elevation tile layout");
  const out = new Float32Array(TILE * TILE);
  for (let i = 0, p = 0; i < out.length; i++, p += channels) {
    out[i] = data[p]! * 256 + data[p + 1]! + data[p + 2]! / 256 - 32768;
  }
  return out;
}

function loadTile(cache: DiskCache, z: number, x: number, y: number): Promise<Tile> {
  const n = 1 << z;
  const wrappedX = ((x % n) + n) % n;
  const clampedY = Math.min(n - 1, Math.max(0, y));
  const key = `${z}/${wrappedX}/${clampedY}`;
  const hit = decoded.get(key);
  if (hit) return hit;
  return remember(
    key,
    (async () => {
      const { data } = await cache.wrap("dem", key, Number.POSITIVE_INFINITY, async () => {
        const url = config.demTiles
          .replace("{z}", String(z))
          .replace("{x}", String(wrappedX))
          .replace("{y}", String(clampedY));
        const response = await upstream(url, { timeoutMs: 15_000 });
        if (!response.ok)
          throw new HttpError(502, `Elevation tile ${key} answered ${response.status}`, "upstream");
        return new Uint8Array(await response.arrayBuffer());
      });
      return decodeTerrarium(data);
    })(),
  );
}

const lonToX = (lon: number, scale: number) => ((lon + 180) / 360) * scale;
function latToY(lat: number, scale: number): number {
  const rad = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * scale;
}

/** Picks the finest zoom that resolves the requested grid without fetching too many tiles. */
export function pickZoom(bbox: BBox, size: number): number {
  const midLat = (bbox.s + bbox.n) / 2;
  const spacing = ((bbox.n - bbox.s) * 111_320) / size;
  const ideal = Math.ceil(
    Math.log2((156_543.034 * Math.cos((midLat * Math.PI) / 180)) / Math.max(spacing, 0.5)),
  );
  let z = Math.max(0, Math.min(MAX_ZOOM, ideal));
  for (; z > 0; z--) {
    const scale = 2 ** z;
    const cols = Math.floor(lonToX(bbox.e, scale)) - Math.floor(lonToX(bbox.w, scale)) + 2;
    const rows = Math.floor(latToY(bbox.s, scale)) - Math.floor(latToY(bbox.n, scale)) + 2;
    if (cols * rows <= MAX_TILES) break;
  }
  return z;
}

/**
 * Samples a `size x size` elevation grid over the bounding box (row 0 is the northern edge,
 * column 0 the western one), bilinearly interpolating the mosaic of terrain tiles.
 */
export async function elevationGrid(cache: DiskCache, bbox: BBox, size: number): Promise<Bytes> {
  const z = pickZoom(bbox, size);
  const scale = 2 ** z * TILE;
  const x0 = lonToX(bbox.w, scale);
  const x1 = lonToX(bbox.e, scale);

  // Sample positions in global pixel space; pixel centres sit at +0.5.
  const xs = new Float64Array(size);
  const ys = new Float64Array(size);
  for (let i = 0; i < size; i++) {
    const t = i / (size - 1);
    xs[i] = x0 + (x1 - x0) * t - 0.5;
    ys[i] = latToY(bbox.n + (bbox.s - bbox.n) * t, scale) - 0.5;
  }

  const minTx = Math.floor(xs[0]! / TILE);
  const maxTx = Math.floor((xs[size - 1]! + 1) / TILE);
  const minTy = Math.floor(ys[0]! / TILE);
  const maxTy = Math.floor((ys[size - 1]! + 1) / TILE);
  const cols = maxTx - minTx + 1;
  const rows = maxTy - minTy + 1;
  const tiles: Tile[] = await Promise.all(
    Array.from({ length: cols * rows }, (_, i) =>
      loadTile(cache, z, minTx + (i % cols), minTy + Math.floor(i / cols)),
    ),
  );

  const originX = minTx * TILE;
  const originY = minTy * TILE;
  const maxPx = cols * TILE - 1;
  const maxPy = rows * TILE - 1;
  const pixel = (px: number, py: number): number => {
    const cx = Math.min(maxPx, Math.max(0, px));
    const cy = Math.min(maxPy, Math.max(0, py));
    const tile = tiles[Math.floor(cy / TILE) * cols + Math.floor(cx / TILE)]!;
    return tile[(cy % TILE) * TILE + (cx % TILE)]!;
  };

  const out = new Uint8Array(DEM_HEADER_BYTES + size * size * 4);
  const header = new DataView(out.buffer);
  header.setUint32(0, DEM_MAGIC, true);
  header.setUint32(4, size, true);
  header.setUint32(8, z, true);
  const grid = new Float32Array(out.buffer, DEM_HEADER_BYTES, size * size);
  for (let row = 0; row < size; row++) {
    const y = ys[row]! - originY;
    const iy = Math.floor(y);
    const fy = y - iy;
    for (let col = 0; col < size; col++) {
      const x = xs[col]! - originX;
      const ix = Math.floor(x);
      const fx = x - ix;
      const top = pixel(ix, iy) * (1 - fx) + pixel(ix + 1, iy) * fx;
      const bottom = pixel(ix, iy + 1) * (1 - fx) + pixel(ix + 1, iy + 1) * fx;
      grid[row * size + col] = top * (1 - fy) + bottom * fy;
    }
  }
  return out;
}
