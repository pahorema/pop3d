import { describe, expect, test } from "bun:test";
import { OSM_COORD_SCALE, type OsmPayload, type OsmTags } from "../shared/types";
import type { BuildParams, PrintPart } from "../src/core/types";
import { projector } from "../src/geo/projection";
import { buildDiorama, gridCells } from "../src/worker/build";
import { buildPrint } from "../src/worker/print";

const LAT = 45.65;
const LON = 13.77;
const projection = projector(LAT, LON);
const origin = { lat: LAT - 0.02, lon: LON - 0.02 };

/** Encodes local metre coordinates the way the server does. */
function encode(points: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < points.length; i += 2) {
    const [lat, lon] = projection.toGeo(points[i]!, points[i + 1]!);
    out.push(
      Math.round((lat - origin.lat) * OSM_COORD_SCALE),
      Math.round((lon - origin.lon) * OSM_COORD_SCALE),
    );
  }
  return out;
}

const box = (x: number, y: number, w: number, d: number) => [x, y, x + w, y, x + w, y + d, x, y + d, x, y];

function payload(): OsmPayload {
  let id = 1;
  const way = (tags: OsmTags, points: number[]) => ({ id: id++, tags, g: encode(points) });
  return {
    v: 1,
    timestamp: "2026-01-01T00:00:00Z",
    origin,
    nodes: [{ id: 900, tags: { natural: "tree" }, p: encode([-60, 80]) as [number, number] }],
    ways: [
      way({ building: "house", height: "9" }, box(-40, -30, 22, 14)),
      way({ building: "yes", "building:levels": "6" }, box(20, 10, 30, 30)),
      // A building straddling the rim gets sliced.
      way({ building: "yes" }, box(170, -20, 60, 40)),
      way({ highway: "residential" }, [-260, -60, 260, -60]),
      way({ highway: "footway" }, [-100, -200, -100, 200]),
      way({ natural: "water" }, [-150, 60, -90, 50, -70, 110, -130, 130, -150, 60]),
      way({ waterway: "river" }, [-260, 150, 0, 170, 260, 140]),
      way({ leisure: "park" }, box(60, -150, 90, 70)),
      way({ natural: "wood" }, box(-180, -170, 70, 80)),
      way({ natural: "coastline" }, [260, 190, 0, 215, -260, 190]),
    ],
    relations: [],
  };
}

/** A gentle slope with a bump, as the elevation service would return it. */
function elevation(params: BuildParams): Float32Array {
  const n = gridCells(params) + 1;
  const grid = new Float32Array(n * n);
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      const x = col / (n - 1) - 0.5;
      const y = 0.5 - row / (n - 1);
      grid[row * n + col] = 20 + x * 30 - y * 18 + 12 * Math.exp(-((x - 0.1) ** 2 + (y + 0.1) ** 2) * 30);
    }
  }
  return grid;
}

/** Counts edges that are not shared by exactly two triangles facing opposite ways. */
function openEdges(part: PrintPart): number {
  const t = part.triangles;
  const ids = new Map<string, number>();
  const id = (i: number) => {
    // Adding zero turns -0 into 0, so that both print as "0.000".
    const key = [0, 1, 2].map((k) => (Math.round(t[i + k]! * 1000) / 1000 + 0).toFixed(3)).join(",");
    let value = ids.get(key);
    if (value === undefined) ids.set(key, (value = ids.size));
    return value;
  };
  const balance = new Map<string, number>();
  for (let i = 0; i < t.length; i += 9) {
    const corners = [id(i), id(i + 3), id(i + 6)];
    if (corners[0] === corners[1] || corners[1] === corners[2] || corners[0] === corners[2]) continue;
    for (let k = 0; k < 3; k++) {
      const a = corners[k]!;
      const b = corners[(k + 1) % 3]!;
      const key = a < b ? `${a}-${b}` : `${b}-${a}`;
      balance.set(key, (balance.get(key) ?? 0) + (a < b ? 1 : -1));
    }
  }
  let open = 0;
  for (const value of balance.values()) if (value !== 0) open++;
  return open;
}

function volume(part: PrintPart): number {
  const t = part.triangles;
  let sum = 0;
  for (let i = 0; i < t.length; i += 9) {
    sum +=
      t[i]! * (t[i + 4]! * t[i + 8]! - t[i + 5]! * t[i + 7]!) -
      t[i + 1]! * (t[i + 3]! * t[i + 8]! - t[i + 5]! * t[i + 6]!) +
      t[i + 2]! * (t[i + 3]! * t[i + 7]! - t[i + 4]! * t[i + 6]!);
  }
  return sum / 6;
}

for (const shape of ["circle", "square", "hexagon", "rounded"] as const) {
  for (const relief of [0, 1.5]) {
    describe(`${shape} diorama, relief ${relief}`, () => {
      const params: BuildParams = {
        area: { lat: LAT, lon: LON, shape, width: 500, depth: 420 },
        detail: 2,
        relief,
        roofs: true,
      };
      const { data, state } = buildDiorama(params, payload(), relief ? elevation(params) : null, () => {});

      test("builds every expected layer with sane geometry", () => {
        for (const layer of ["base", "ground", "water", "roads", "paths", "green", "forest"] as const) {
          const mesh = data.layers[layer];
          expect(mesh, layer).toBeDefined();
          expect(mesh!.indices.length, layer).toBeGreaterThan(0);
          for (const value of mesh!.positions) expect(Number.isFinite(value)).toBe(true);
          let max = 0;
          for (const index of mesh!.indices) if (index > max) max = index;
          expect(max).toBeLessThan(mesh!.positions.length / 3);
        }
        expect(data.buildings.info.length).toBe(3);
        expect(data.trees.count).toBeGreaterThan(5);
        expect(data.topY).toBeGreaterThanOrEqual(data.groundTopY);
        expect(data.bottomY).toBeLessThan(0);
      });

      test("keeps the model inside its outline", () => {
        for (const mesh of [data.layers.ground!, data.layers.roads!, data.buildings]) {
          for (let i = 0; i < mesh.positions.length; i += 3) {
            expect(Math.abs(mesh.positions[i]!)).toBeLessThanOrEqual(250.02);
            expect(Math.abs(mesh.positions[i + 2]!)).toBeLessThanOrEqual(210.02);
          }
        }
      });

      test("exports closed, outward-facing solids for printing", () => {
        const { parts, scale } = buildPrint(state, {
          sizeMm: 150,
          baseMm: 3,
          zScale: 1.5,
          minFeatureMm: 0.4,
          layers: ["base", "water", "roads", "paths", "green", "forest", "buildings", "trees"],
        });
        expect(scale).toBeCloseTo(0.3, 6);
        const layers = parts.map((part) => part.layer);
        for (const layer of [
          "base",
          "water",
          "roads",
          "paths",
          "green",
          "forest",
          "buildings",
          "trees",
        ] as const) {
          expect(layers).toContain(layer);
        }
        for (const part of parts) {
          expect(openEdges(part), `open edges in ${part.layer}`).toBe(0);
          expect(volume(part), `volume of ${part.layer}`).toBeGreaterThan(0);
        }
        const base = parts.find((part) => part.layer === "base")!;
        let lowest = Number.POSITIVE_INFINITY;
        for (let i = 2; i < base.triangles.length; i += 3) lowest = Math.min(lowest, base.triangles[i]!);
        expect(lowest).toBeCloseTo(-3, 5);
      });
    });
  }
}
