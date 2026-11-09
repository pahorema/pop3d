import { config } from "./config";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code = "error",
  ) {
    super(message);
  }
}

export function json(data: unknown, init: ResponseInit & { maxAge?: number } = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  if (init.maxAge !== undefined) headers.set("cache-control", `public, max-age=${init.maxAge}`);
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) {
    return json({ error: error.message, code: error.code }, { status: error.status });
  }
  console.error("[server] unexpected error:", error);
  return json({ error: "Internal error", code: "internal" }, { status: 500 });
}

/** `fetch` with a hard deadline and the configured User-Agent. */
export async function upstream(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const { timeoutMs = 20_000, signal, ...rest } = init;
  const timeout = AbortSignal.timeout(timeoutMs);
  const headers = new Headers(rest.headers);
  headers.set("user-agent", config.userAgent);
  return fetch(url, { ...rest, headers, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
}

export function numberParam(url: URL, name: string, min: number, max: number): number {
  const raw = url.searchParams.get(name);
  const value = raw === null || raw.trim() === "" ? Number.NaN : Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new HttpError(400, `Invalid parameter "${name}"`, "bad_request");
  }
  return value;
}

export interface BBox {
  s: number;
  w: number;
  n: number;
  e: number;
}

const METERS_PER_DEGREE = 111_320;

/** Reads and validates `s,w,n,e` query parameters, rejecting areas larger than the configured limit. */
export function bboxParam(url: URL): BBox {
  const s = numberParam(url, "s", -85, 85);
  const n = numberParam(url, "n", -85, 85);
  const w = numberParam(url, "w", -180, 180);
  const e = numberParam(url, "e", -180, 180);
  if (n <= s || e <= w) throw new HttpError(400, "Empty bounding box", "bad_request");
  const height = (n - s) * METERS_PER_DEGREE;
  const width = (e - w) * METERS_PER_DEGREE * Math.cos((((s + n) / 2) * Math.PI) / 180);
  if (height > config.maxSpan || width > config.maxSpan) {
    throw new HttpError(413, "Area too large", "too_large");
  }
  return { s, w, n, e };
}

/** Token bucket keyed by client address; cheap protection for the upstream services we lean on. */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
  ) {}

  take(key: string): boolean {
    const now = Date.now();
    const bucket = this.buckets.get(key) ?? { tokens: this.capacity, at: now };
    bucket.tokens = Math.min(
      this.capacity,
      bucket.tokens + ((now - bucket.at) / 1000) * this.refillPerSecond,
    );
    bucket.at = now;
    const allowed = bucket.tokens >= 1;
    if (allowed) bucket.tokens -= 1;
    this.buckets.set(key, bucket);
    if (this.buckets.size > 5000) {
      for (const [k, b] of this.buckets) if (now - b.at > 600_000) this.buckets.delete(k);
    }
    return allowed;
  }
}

/** Runs tasks one after another, leaving at least `gapMs` between starts. */
export class Throttle {
  private tail: Promise<unknown> = Promise.resolve();
  private last = 0;

  constructor(private readonly gapMs: number) {}

  run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.tail.then(async () => {
      const wait = this.last + this.gapMs - Date.now();
      if (wait > 0) await Bun.sleep(wait);
      this.last = Date.now();
      return task();
    });
    this.tail = next.catch(() => {});
    return next;
  }
}
