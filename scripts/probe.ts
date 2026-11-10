/**
 * Builds a diorama headlessly against a running server and prints what came out.
 *
 *   bun run scripts/probe.ts "45.6503,13.7678" 600 circle 1 1.5
 */
import { DEM_HEADER_BYTES, type OsmPayload } from "../shared/types";
import type { BuildParams, Detail, ShapeKind } from "../src/core/types";
import { areaBounds } from "../src/geo/projection";
import { buildDiorama, GRID_PAD, gridCells } from "../src/worker/build";

const [where = "45.6503,13.7678", size = "600", shape = "circle", detail = "1", relief = "1"] =
  process.argv.slice(2);
const [lat, lon] = where.split(",").map(Number) as [number, number];
const server = process.env.POP3D_SERVER ?? "http://localhost:4310";

const params: BuildParams = {
  area: { lat, lon, shape: shape as ShapeKind, width: Number(size), depth: Number(size) },
  detail: Number(detail) as Detail,
  relief: Number(relief),
  roofs: true,
};

const fmt = (b: { s: number; w: number; n: number; e: number }, digits: number) =>
  `s=${b.s.toFixed(digits)}&w=${b.w.toFixed(digits)}&n=${b.n.toFixed(digits)}&e=${b.e.toFixed(digits)}`;

let started = performance.now();
const osm = (await (
  await fetch(`${server}/api/osm?${fmt(areaBounds(params.area, 25), 5)}`)
).json()) as OsmPayload;
console.log(
  `osm: ${osm.ways.length} ways, ${osm.relations.length} relations, ${osm.nodes.length} nodes in ${Math.round(performance.now() - started)} ms`,
);

let elevation: Float32Array | null = null;
if (params.relief > 0) {
  started = performance.now();
  const n = gridCells(params) + 1;
  const buffer = await (
    await fetch(`${server}/api/dem?${fmt(areaBounds(params.area, GRID_PAD), 7)}&size=${n}`)
  ).arrayBuffer();
  elevation = new Float32Array(buffer, DEM_HEADER_BYTES, n * n);
  console.log(`dem: ${n}x${n} in ${Math.round(performance.now() - started)} ms`);
}

const { data } = buildDiorama(params, osm, elevation, () => {});
console.log("stats:", data.stats);
console.log(
  `bottomY ${data.bottomY.toFixed(1)}, groundTopY ${data.groundTopY.toFixed(1)}, topY ${data.topY.toFixed(1)}`,
);
for (const [layer, mesh] of Object.entries(data.layers)) {
  console.log(
    `  ${layer.padEnd(10)} ${String(mesh.positions.length / 3).padStart(8)} vertices ${String(mesh.indices.length / 3).padStart(8)} triangles`,
  );
}
console.log(
  `  buildings  ${String(data.buildings.positions.length / 3).padStart(8)} vertices ${String(data.buildings.indices.length / 3).padStart(8)} triangles (${data.buildings.info.length})`,
);
console.log(`  trees      ${data.trees.count}`);
