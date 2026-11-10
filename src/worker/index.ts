import { DEM_HEADER_BYTES, DEM_MAGIC, type OsmPayload } from "../../shared/types";
import type { BuildParams, WorkerRequest, WorkerResponse } from "../core/types";
import { areaBounds } from "../geo/projection";
import { type BuildState, buildDiorama, GRID_PAD, gridCells, transferables } from "./build";
import { buildPrint } from "./print";

const scope = self as unknown as {
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
};

class BuildError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

let state: BuildState | null = null;
let latest = 0;

async function request(url: string): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url);
  } catch {
    throw new BuildError("network", "Network unreachable");
  }
  if (!response.ok) {
    const code =
      response.status === 429 ? "rate_limited" : response.status === 413 ? "too_large" : "upstream";
    let message = `HTTP ${response.status}`;
    try {
      message = ((await response.json()) as { error?: string }).error ?? message;
    } catch {
      // Not a JSON error body: keep the status line.
    }
    throw new BuildError(code, message);
  }
  return response;
}

// The last downloads are kept, so that changing shape, detail or relief of the same area
// rebuilds the model without going back to the network.
let osmCache: { query: string; payload: OsmPayload } | null = null;
let elevationCache: { query: string; grid: Float32Array } | null = null;

async function fetchOsm(params: BuildParams): Promise<OsmPayload> {
  const b = areaBounds(params.area, 25);
  const query = `s=${b.s.toFixed(5)}&w=${b.w.toFixed(5)}&n=${b.n.toFixed(5)}&e=${b.e.toFixed(5)}`;
  if (osmCache?.query === query) return osmCache.payload;
  const payload = (await (await request(`/api/osm?${query}`)).json()) as OsmPayload;
  osmCache = { query, payload };
  return payload;
}

async function fetchElevation(params: BuildParams): Promise<Float32Array | null> {
  if (params.relief <= 0) return null;
  const size = gridCells(params) + 1;
  const b = areaBounds(params.area, GRID_PAD);
  const query = `s=${b.s.toFixed(7)}&w=${b.w.toFixed(7)}&n=${b.n.toFixed(7)}&e=${b.e.toFixed(7)}&size=${size}`;
  if (elevationCache?.query === query) return elevationCache.grid;
  try {
    const buffer = await (await request(`/api/dem?${query}`)).arrayBuffer();
    const header = new DataView(buffer);
    if (header.getUint32(0, true) !== DEM_MAGIC || header.getUint32(4, true) !== size) return null;
    const grid = new Float32Array(buffer, DEM_HEADER_BYTES, size * size);
    elevationCache = { query, grid };
    return grid;
  } catch (error) {
    // A flat model beats no model: elevation is a nice-to-have.
    console.warn("[pop3d] elevation unavailable, building flat", error);
    return null;
  }
}

async function build(id: number, params: BuildParams): Promise<void> {
  latest = id;
  const stale = () => latest !== id;
  scope.postMessage({ type: "progress", id, stage: "osm", ratio: 0 });
  const elevationPromise = fetchElevation(params);
  elevationPromise.catch(() => {});
  const osm = await fetchOsm(params);
  if (stale()) return;
  scope.postMessage({ type: "progress", id, stage: "terrain", ratio: 0 });
  const elevation = await elevationPromise;
  if (stale()) return;
  scope.postMessage({ type: "progress", id, stage: "geometry", ratio: 0 });
  // Let the progress message leave before the heavy lifting blocks this thread.
  await new Promise((resolve) => setTimeout(resolve, 0));
  let last = 0;
  const result = buildDiorama(params, osm, elevation, (ratio) => {
    if (ratio - last < 0.04) return;
    last = ratio;
    scope.postMessage({ type: "progress", id, stage: "geometry", ratio });
  });
  if (stale()) return;
  state = result.state;
  scope.postMessage({ type: "built", id, data: result.data }, transferables(result.data));
}

scope.onmessage = (event) => {
  const message = event.data;
  if (message.type === "build") {
    build(message.id, message.params).catch((error: unknown) => {
      const code = error instanceof BuildError ? error.code : "internal";
      if (code === "internal") console.error("[pop3d] build failed", error);
      scope.postMessage({ type: "error", id: message.id, code, message: (error as Error).message });
    });
  } else if (message.type === "print") {
    try {
      if (!state) throw new BuildError("no_model", "Nothing to export yet");
      const { parts, scale } = buildPrint(state, message.params);
      scope.postMessage(
        { type: "printed", id: message.id, parts, scale },
        parts.flatMap((part) => [part.triangles.buffer as ArrayBuffer, part.shells.buffer as ArrayBuffer]),
      );
    } catch (error) {
      const code = error instanceof BuildError ? error.code : "internal";
      scope.postMessage({ type: "error", id: message.id, code, message: (error as Error).message });
    }
  }
};
