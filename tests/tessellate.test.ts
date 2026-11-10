import { describe, expect, test } from "bun:test";
import { difference, normalize, toPath, toPolygons, toRings, union } from "../src/worker/clip";
import { type Ring, ringArea, rng } from "../src/worker/poly";
import { type Grid, type Tessellation, tessellate } from "../src/worker/tessellate";

function grid(min: number, max: number, cells: number): Grid {
  const lines = new Float64Array(cells + 1);
  for (let i = 0; i <= cells; i++) lines[i] = min + ((max - min) * i) / cells;
  return { xs: lines, ys: lines.slice(), diagonal: (ix, iy) => (ix + iy) % 2 };
}

function meshArea(tess: Tessellation): number {
  let total = 0;
  for (let i = 0; i < tess.triangles.length; i += 3) {
    const a = tess.triangles[i]! * 2;
    const b = tess.triangles[i + 1]! * 2;
    const c = tess.triangles[i + 2]! * 2;
    const area =
      ((tess.xy[b]! - tess.xy[a]!) * (tess.xy[c + 1]! - tess.xy[a + 1]!) -
        (tess.xy[b + 1]! - tess.xy[a + 1]!) * (tess.xy[c]! - tess.xy[a]!)) /
      2;
    expect(area).toBeGreaterThan(0);
    total += area;
  }
  return total;
}

function outlineLength(tess: Tessellation): number {
  let total = 0;
  for (let i = 0; i < tess.edges.length; i += 4) {
    total += Math.hypot(tess.edges[i + 2]! - tess.edges[i]!, tess.edges[i + 3]! - tess.edges[i + 1]!);
  }
  return total;
}

function perimeter(rings: Ring[]): number {
  let total = 0;
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i += 2) {
      const j = (i + 2) % ring.length;
      total += Math.hypot(ring[j]! - ring[i]!, ring[j + 1]! - ring[i + 1]!);
    }
  }
  return total;
}

function circle(cx: number, cy: number, r: number, steps = 48): Ring {
  const ring: Ring = [];
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    ring.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
  }
  return ring;
}

describe("clipper conventions", () => {
  test("outer rings come out counter-clockwise and holes clockwise", () => {
    const paths = normalize([circle(0, 0, 10), circle(0, 0, 4)]);
    const rings = toRings(paths);
    expect(rings).toHaveLength(2);
    const areas = rings.map(ringArea).sort((a, b) => a - b);
    expect(areas[0]).toBeLessThan(0);
    expect(areas[1]).toBeGreaterThan(0);
    const polygons = toPolygons(paths);
    expect(polygons).toHaveLength(1);
    expect(polygons[0]!.holes).toHaveLength(1);
  });

  test("winding of the input does not matter", () => {
    const clockwise = circle(0, 0, 10).reverse();
    for (let i = 0; i < clockwise.length; i += 2) {
      [clockwise[i], clockwise[i + 1]] = [clockwise[i + 1]!, clockwise[i]!];
    }
    expect(ringArea(toRings(normalize([clockwise]))[0]!)).toBeGreaterThan(0);
  });
});

describe("tessellate", () => {
  const g = grid(-50.0037, 50.0037, 16);

  test("covers a simple polygon exactly", () => {
    const rings = toRings([toPath(circle(3, -2, 31))]);
    const tess = tessellate(rings, g);
    expect(meshArea(tess)).toBeCloseTo(ringArea(rings[0]!), 4);
    expect(outlineLength(tess)).toBeCloseTo(perimeter(rings), 4);
  });

  test("respects holes, including ones spanning many cells", () => {
    const paths = difference(
      [toPath(circle(0, 0, 44))],
      union([toPath(circle(5, 5, 20)), toPath(circle(-25, -20, 3))]),
    );
    const rings = toRings(paths);
    const expected = rings.reduce((sum, ring) => sum + ringArea(ring), 0);
    const tess = tessellate(rings, g);
    expect(meshArea(tess)).toBeCloseTo(expected, 4);
    expect(outlineLength(tess)).toBeCloseTo(perimeter(rings), 4);
  });

  test("handles polygons smaller than a cell and thin ribbons", () => {
    const rings = toRings(
      union([
        toPath(circle(1, 1, 0.8, 12)),
        toPath([-48, -30, 48, -29, 48, -28.5, -48, -29.5]),
        toPath([10, -48, 10.4, -48, 12.4, 48, 12, 48]),
      ]),
    );
    const expected = rings.reduce((sum, ring) => sum + ringArea(ring), 0);
    const tess = tessellate(rings, g);
    expect(meshArea(tess)).toBeCloseTo(expected, 4);
  });

  test("covers the whole grid when the polygon is larger than a cell everywhere", () => {
    const rings: Ring[] = [[-50, -50, 50, -50, 50, 50, -50, 50]];
    const tess = tessellate(rings, g);
    expect(meshArea(tess)).toBeCloseTo(10_000, 6);
    // Interior cells are plain quads on shared grid vertices.
    expect(tess.triangles.length / 3).toBeLessThan(16 * 16 * 2 + 200);
  });

  test("random blobs keep their area on fine and coarse grids", () => {
    const random = rng(7);
    for (let round = 0; round < 25; round++) {
      const shapes = [];
      for (let k = 0; k < 6; k++) {
        const ring: Ring = [];
        const cx = (random() - 0.5) * 60;
        const cy = (random() - 0.5) * 60;
        const steps = 5 + Math.floor(random() * 30);
        for (let i = 0; i < steps; i++) {
          const a = (i / steps) * Math.PI * 2;
          const r = 4 + random() * 16;
          ring.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
        }
        shapes.push(...normalize([ring]));
      }
      const holes = union([toPath(circle((random() - 0.5) * 40, (random() - 0.5) * 40, 6 + random() * 8))]);
      const rings = toRings(difference(union(shapes), holes)).filter((ring) =>
        ring.every((v) => Math.abs(v) < 50),
      );
      const expected = rings.reduce((sum, ring) => sum + ringArea(ring), 0);
      for (const cells of [1, 5, 16, 41]) {
        const tess = tessellate(rings, grid(-50.0037, 50.0037, cells));
        expect(Math.abs(meshArea(tess) - expected)).toBeLessThan(1e-3);
        expect(Math.abs(outlineLength(tess) - perimeter(rings))).toBeLessThan(1e-3);
      }
    }
  });
});
