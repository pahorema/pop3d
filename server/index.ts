import { join, normalize, sep } from "node:path";
import type { Server } from "bun";
import { DiskCache } from "./cache";
import { config } from "./config";
import { elevationGrid } from "./dem";
import { reverse, search, suggest } from "./geocode";
import { bboxParam, errorResponse, HttpError, json, numberParam, RateLimiter } from "./http";
import { osmExtract } from "./overpass";

const cache = new DiskCache(config.cacheDir, config.cacheMaxBytes);

const limits = {
  geocode: new RateLimiter(40, 1),
  osm: new RateLimiter(20, 0.25),
  dem: new RateLimiter(30, 0.5),
};

const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "geolocation=(self)",
};

const COMPRESSIBLE = /\.(html|js|css|json|svg|txt|map|webmanifest)$/;
const gzipped = new Map<string, Uint8Array<ArrayBuffer>>();
const reloadClients = new Set<ReadableStreamDefaultController<Uint8Array>>();

function clientKey(request: Request, server: Server<unknown>): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || server.requestIP(request)?.address || "unknown";
}

function language(url: URL, request: Request): string {
  const explicit = url.searchParams.get("lang");
  const header = request.headers.get("accept-language")?.split(",")[0];
  const lang = (explicit ?? header ?? "en").trim().slice(0, 2).toLowerCase();
  return /^[a-z]{2}$/.test(lang) ? lang : "en";
}

function guard(limiter: RateLimiter, key: string): void {
  if (!limiter.take(key)) throw new HttpError(429, "Too many requests, slow down a little", "rate_limited");
}

function acceptsGzip(request: Request): boolean {
  return /\bgzip\b/.test(request.headers.get("accept-encoding") ?? "");
}

async function api(url: URL, request: Request, server: Server<unknown>): Promise<Response> {
  const who = clientKey(request, server);
  switch (url.pathname) {
    case "/api/health":
      return json({ ok: true, version: config.version });

    case "/api/suggest": {
      guard(limits.geocode, who);
      const q = url.searchParams.get("q")?.trim() ?? "";
      if (q.length < 2) return json([]);
      const hasBias = url.searchParams.has("lat") && url.searchParams.has("lon");
      const bias = hasBias
        ? { lat: numberParam(url, "lat", -90, 90), lon: numberParam(url, "lon", -180, 180) }
        : undefined;
      return json(await suggest(cache, q, language(url, request), bias), { maxAge: 3600 });
    }

    case "/api/geocode": {
      guard(limits.geocode, who);
      const q = url.searchParams.get("q")?.trim() ?? "";
      if (q.length < 2) return json([]);
      return json(await search(cache, q, language(url, request)), { maxAge: 3600 });
    }

    case "/api/reverse": {
      guard(limits.geocode, who);
      const lat = numberParam(url, "lat", -90, 90);
      const lon = numberParam(url, "lon", -180, 180);
      return json(await reverse(cache, lat, lon, language(url, request)), { maxAge: 86_400 });
    }

    case "/api/osm": {
      guard(limits.osm, who);
      const bbox = bboxParam(url);
      const { data, fresh } = await osmExtract(cache, bbox);
      const headers = {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "public, max-age=86400",
        "x-cache": fresh ? "miss" : "hit",
      };
      if (acceptsGzip(request)) {
        return new Response(data, {
          headers: { ...headers, "content-encoding": "gzip", vary: "accept-encoding" },
        });
      }
      return new Response(Bun.gunzipSync(data), { headers });
    }

    case "/api/dem": {
      guard(limits.dem, who);
      const bbox = bboxParam(url);
      const size = Math.round(numberParam(url, "size", 16, 513));
      const grid = await elevationGrid(cache, bbox, size);
      return new Response(grid, {
        headers: { "content-type": "application/octet-stream", "cache-control": "public, max-age=604800" },
      });
    }
  }
  throw new HttpError(404, "Unknown endpoint", "not_found");
}

function devReloadStream(): Response {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      reloadClients.add(c);
      c.enqueue(new TextEncoder().encode(": connected\n\n"));
    },
    cancel() {
      reloadClients.delete(controller);
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" },
  });
}

/** Tells every open dev page to reload itself. */
export function notifyReload(): void {
  const message = new TextEncoder().encode("data: reload\n\n");
  for (const client of reloadClients) {
    try {
      client.enqueue(message);
    } catch {
      reloadClients.delete(client);
    }
  }
  gzipped.clear();
}

async function serveStatic(url: URL, request: Request): Promise<Response> {
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    throw new HttpError(400, "Malformed path", "bad_request");
  }
  let path = normalize(join(config.distDir, pathname));
  if (path !== config.distDir && !path.startsWith(config.distDir + sep))
    throw new HttpError(403, "Forbidden", "forbidden");

  let file = Bun.file(path);
  const looksLikeAsset = /\.[a-z0-9]+$/i.test(pathname);
  if (pathname.endsWith("/") || !(await file.exists())) {
    if (looksLikeAsset) throw new HttpError(404, "Not found", "not_found");
    path = join(config.distDir, "index.html");
    file = Bun.file(path);
    if (!(await file.exists()))
      throw new HttpError(503, "The app has not been built yet: run `bun run build`", "not_built");
  }

  const immutable = /^\/(assets|fonts)\//.test(pathname);
  const headers: Record<string, string> = {
    "content-type": file.type,
    "cache-control": immutable && !config.dev ? "public, max-age=31536000, immutable" : "no-cache",
    ...SECURITY_HEADERS,
  };
  if (request.method === "HEAD") return new Response(null, { headers });

  if (!config.dev && COMPRESSIBLE.test(path) && acceptsGzip(request)) {
    let body = gzipped.get(path);
    if (!body) {
      body = Bun.gzipSync(new Uint8Array(await file.arrayBuffer()));
      gzipped.set(path, body);
    }
    return new Response(body, {
      headers: { ...headers, "content-encoding": "gzip", vary: "accept-encoding" },
    });
  }
  return new Response(file, { headers });
}

export function startServer(): Server<unknown> {
  const server = Bun.serve({
    port: config.port,
    hostname: config.host,
    idleTimeout: 120,
    async fetch(request, server) {
      const url = new URL(request.url);
      try {
        if (request.method !== "GET" && request.method !== "HEAD") {
          throw new HttpError(405, "Method not allowed", "method_not_allowed");
        }
        if (url.pathname.startsWith("/api/")) return await api(url, request, server);
        if (config.dev && url.pathname === "/__dev/reload") return devReloadStream();
        return await serveStatic(url, request);
      } catch (error) {
        return errorResponse(error);
      }
    },
  });

  void cache.prune().then(({ files, bytes, removed }) => {
    console.log(
      `[cache] ${files} entries, ${(bytes / 1e6).toFixed(1)} MB${removed ? `, pruned ${removed}` : ""}`,
    );
  });
  console.log(`[pop3d] v${config.version} listening on http://${server.hostname}:${server.port}`);
  return server;
}

if (import.meta.main) startServer();
