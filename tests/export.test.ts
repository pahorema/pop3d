import { describe, expect, test } from "bun:test";
import { strFromU8, unzipSync } from "fflate";
import type { LayerId, PrintPart } from "../src/core/types";
import { write3mf, writeStl } from "../src/export/print";

/** A unit tetrahedron and a shifted copy: two tiny closed parts. */
function tetrahedron(dx: number): Float32Array {
  const v = [
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ].map(([x, y, z]) => [x! + dx, y!, z!]);
  const faces = [
    [0, 2, 1],
    [0, 1, 3],
    [1, 2, 3],
    [0, 3, 2],
  ];
  return new Float32Array(faces.flatMap((face) => face.flatMap((i) => v[i]!)));
}

const parts: PrintPart[] = [
  { layer: "base", triangles: tetrahedron(0) },
  { layer: "buildings", triangles: tetrahedron(5) },
];

describe("print exports", () => {
  test("binary STL has the standard layout and outward normals", async () => {
    const buffer = await writeStl(parts, "Tèst plàce").arrayBuffer();
    const view = new DataView(buffer);
    expect(view.getUint32(80, true)).toBe(8);
    expect(buffer.byteLength).toBe(84 + 8 * 50);
    // First facet lies in the z = 0 plane and faces down.
    expect(view.getFloat32(84, true)).toBeCloseTo(0, 6);
    expect(view.getFloat32(88, true)).toBeCloseTo(0, 6);
    expect(view.getFloat32(92, true)).toBeCloseTo(-1, 6);
    expect(new TextDecoder().decode(new Uint8Array(buffer, 0, 5))).not.toBe("solid");
  });

  test("3MF is a valid package with indexed, coloured parts", async () => {
    const colors = { base: "#aabbcc", buildings: "#ff8800" } as Record<LayerId, string>;
    const names = { base: "Terrain & base", buildings: "Buildings" } as Record<LayerId, string>;
    const blob = write3mf(parts, colors, names, 'A "quoted" <title>');
    const files = unzipSync(new Uint8Array(await blob.arrayBuffer()));
    expect(Object.keys(files).sort()).toEqual(["3D/3dmodel.model", "[Content_Types].xml", "_rels/.rels"]);
    expect(strFromU8(files["_rels/.rels"]!)).toContain("/3D/3dmodel.model");

    const model = strFromU8(files["3D/3dmodel.model"]!);
    expect(model).toContain('unit="millimeter"');
    expect(model).toContain('displaycolor="#AABBCCFF"');
    expect(model).toContain('displaycolor="#FF8800FF"');
    expect(model).toContain("Terrain &amp; base");
    expect(model).toContain("A &quot;quoted&quot; &lt;title>");
    // Each tetrahedron is welded down to four shared vertices.
    expect(model.match(/<vertex /g)).toHaveLength(8);
    expect(model.match(/<triangle /g)).toHaveLength(8);
    for (const [, a, b, c] of model.matchAll(/<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)"/g)) {
      for (const index of [a, b, c]) expect(Number(index)).toBeLessThan(4);
    }
    expect(model.match(/<component /g)).toHaveLength(2);
    expect(model.match(/<item /g)).toHaveLength(1);
    // Tags must balance for the XML to be well formed.
    for (const tag of [
      "model",
      "resources",
      "basematerials",
      "object",
      "mesh",
      "vertices",
      "triangles",
      "build",
    ]) {
      expect(model.split(`<${tag}`).length).toBe(model.split(`</${tag}>`).length);
    }
  });
});
