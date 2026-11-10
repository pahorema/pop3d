import { describe, expect, test } from "bun:test";
import { ringArea } from "../src/worker/poly";
import { chooseRoof, roofPieces } from "../src/worker/roofs";

const house = [0, 0, 12, 0, 12, 8, 0, 8];
const area = (rings: { ring: number[] }[]) =>
  rings.reduce((sum, piece) => sum + Math.abs(ringArea(piece.ring)), 0);

describe("roofs", () => {
  test("a gabled roof has two facets meeting on a ridge along the long side", () => {
    const pieces = roofPieces(house, "gabled", 3, {})!;
    expect(pieces).toHaveLength(2);
    expect(area(pieces)).toBeCloseTo(96, 3);
    for (const piece of pieces) {
      expect(Math.max(...piece.z)).toBeCloseTo(3, 5);
      expect(Math.min(...piece.z)).toBeCloseTo(0, 5);
      // The ridge sits at half the depth.
      piece.z.forEach((z, i) => {
        if (z > 2.99) expect(piece.ring[i * 2 + 1]).toBeCloseTo(4, 2);
      });
    }
  });

  test("a hipped roof adds two triangular ends", () => {
    const pieces = roofPieces(house, "hipped", 3, {})!;
    expect(pieces).toHaveLength(4);
    expect(area(pieces)).toBeCloseTo(96, 3);
    expect(pieces.filter((piece) => piece.ring.length === 6)).toHaveLength(2);
  });

  test("pyramids and domes rise to a single apex over the centre", () => {
    const pyramid = roofPieces(house, "pyramidal", 5, {})!;
    expect(pyramid).toHaveLength(4);
    expect(area(pyramid)).toBeCloseTo(96, 6);
    const dome = roofPieces(house, "dome", 5, {})!;
    expect(area(dome)).toBeCloseTo(96, 6);
    expect(Math.max(...dome.flatMap((piece) => piece.z))).toBeCloseTo(5, 6);
    expect(dome.every((piece) => piece.normals?.length === (piece.ring.length / 2) * 3)).toBe(true);
  });

  test("a skillion slopes across the short side or towards the tagged direction", () => {
    const across = roofPieces(house, "skillion", 2, {})!;
    expect(across).toHaveLength(1);
    expect(new Set(across[0]!.z.map((z) => z.toFixed(3)))).toEqual(new Set(["0.000", "2.000"]));
    const east = roofPieces(house, "skillion", 2, { "roof:direction": "90" })!;
    // Sloping down towards the east: the western corners are the high ones.
    expect(east[0]!.z[0]).toBeCloseTo(2, 5);
    expect(east[0]!.z[1]).toBeCloseTo(0, 5);
  });

  test("roofs are chosen from tags first, then from what the building looks like", () => {
    expect(chooseRoof({ "roof:shape": "flat" }, "house", house, 96, 7, 1)).toBeNull();
    expect(chooseRoof({ "roof:shape": "dome" }, "yes", house, 96, 20, 1)?.shape).toBe("dome");
    expect(chooseRoof({}, "house", house, 96, 7, 1)).not.toBeNull();
    expect(chooseRoof({}, "apartments", house, 96, 15, 1)).toBeNull();
    expect(chooseRoof({}, "yes", [0, 0, 60, 0, 60, 40, 0, 40], 2400, 12, 1)).toBeNull();
    // An L-shaped house does not get a single ridge forced on it.
    const lShape = [0, 0, 14, 0, 14, 5, 5, 5, 5, 14, 0, 14];
    expect(chooseRoof({}, "house", lShape, 115, 7, 1)).toBeNull();
    const roof = chooseRoof({}, "house", house, 96, 7, 1)!;
    expect(roof.height).toBeLessThanOrEqual(7 * 0.48);
  });
});
