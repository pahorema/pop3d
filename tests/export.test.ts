import { describe, expect, test } from "bun:test";
import { strFromU8, unzipSync } from "fflate";
import type { LayerId, PrintPart } from "../src/core/types";
import { writeGlb } from "../src/export/glb";
import type { ExportMesh } from "../src/export/mesh";
import { writeObj } from "../src/export/obj";
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
  test("binary STL has the standard layout and outward normals", () => {
    const bytes = writeStl(parts, "Tèst plàce");
    const buffer = bytes.buffer;
    const view = new DataView(buffer);
    expect(view.getUint32(80, true)).toBe(8);
    expect(buffer.byteLength).toBe(84 + 8 * 50);
    // First facet lies in the z = 0 plane and faces down.
    expect(view.getFloat32(84, true)).toBeCloseTo(0, 6);
    expect(view.getFloat32(88, true)).toBeCloseTo(0, 6);
    expect(view.getFloat32(92, true)).toBeCloseTo(-1, 6);
    expect(new TextDecoder().decode(new Uint8Array(buffer, 0, 5))).not.toBe("solid");
  });

  test("3MF is a valid package with indexed, coloured parts", () => {
    const colors = { base: "#aabbcc", buildings: "#ff8800" } as Record<LayerId, string>;
    const names = { base: "Terrain & base", buildings: "Buildings" } as Record<LayerId, string>;
    const files = unzipSync(write3mf(parts, colors, names, 'A "quoted" <title>'));
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

const quad: ExportMesh = {
  name: "ground",
  positions: new Float32Array([0, 0, 0, 2, 0, 0, 2, 0, -3, 0, 0, -3]),
  normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
  indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  color: "#ff8000",
  roughness: 0.9,
  metalness: 0,
};
const painted: ExportMesh = {
  ...quad,
  name: "buildings",
  color: null,
  colors: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 1, 1]),
};

describe("model exports", () => {
  test("GLB follows the binary glTF 2.0 container and accessor rules", () => {
    const bytes = writeGlb([quad, painted], {
      title: "Tèst",
      copyright: "© someone",
      extras: { latitude: 45 },
    });
    const view = new DataView(bytes.buffer);
    expect(view.getUint32(0, true)).toBe(0x46546c67);
    expect(view.getUint32(4, true)).toBe(2);
    expect(view.getUint32(8, true)).toBe(bytes.length);
    const jsonLength = view.getUint32(12, true);
    expect(jsonLength % 4).toBe(0);
    expect(view.getUint32(16, true)).toBe(0x4e4f534a);
    const gltf = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength)));
    const binStart = 20 + jsonLength;
    const binLength = view.getUint32(binStart, true);
    expect(view.getUint32(binStart + 4, true)).toBe(0x004e4942);
    expect(binStart + 8 + binLength).toBe(bytes.length);
    expect(gltf.buffers[0].byteLength).toBe(binLength);

    expect(gltf.asset).toEqual({ version: "2.0", generator: "pop3d", copyright: "© someone" });
    expect(gltf.scenes[0]).toEqual({ name: "Tèst", nodes: [0, 1], extras: { latitude: 45 } });
    expect(gltf.nodes.map((node: { name: string }) => node.name)).toEqual(["ground", "buildings"]);
    // sRGB #ff8000 becomes linear light in the material.
    const [r, g, b, a] = gltf.materials[0].pbrMetallicRoughness.baseColorFactor;
    expect(r).toBeCloseTo(1, 5);
    expect(g).toBeCloseTo(0.2159, 3);
    expect(b).toBe(0);
    expect(a).toBe(1);
    expect(gltf.meshes[1].primitives[0].attributes.COLOR_0).toBeDefined();
    expect(gltf.meshes[0].primitives[0].attributes.COLOR_0).toBeUndefined();

    for (const bufferView of gltf.bufferViews) {
      expect(bufferView.byteOffset % 4).toBe(0);
      expect(bufferView.byteOffset + bufferView.byteLength).toBeLessThanOrEqual(binLength);
    }
    const position = gltf.accessors[gltf.meshes[0].primitives[0].attributes.POSITION];
    expect(position).toMatchObject({
      componentType: 5126,
      count: 4,
      type: "VEC3",
      min: [0, 0, -3],
      max: [2, 0, 0],
    });
    const indices = gltf.accessors[gltf.meshes[0].primitives[0].indices];
    expect(indices).toMatchObject({ componentType: 5125, count: 6, type: "SCALAR" });
    // The index data really is where the accessor says.
    const indexView = gltf.bufferViews[indices.bufferView];
    const stored = new Uint32Array(
      bytes.buffer.slice(binStart + 8 + indexView.byteOffset, binStart + 8 + indexView.byteOffset + 24),
    );
    expect([...stored]).toEqual([0, 1, 2, 0, 2, 3]);
  });

  test("an empty model is still a valid glTF", () => {
    const bytes = writeGlb([], { title: "empty" });
    const jsonLength = new DataView(bytes.buffer).getUint32(12, true);
    const gltf = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength)));
    expect(bytes.length).toBe(20 + jsonLength);
    expect(gltf.nodes).toBeUndefined();
    expect(gltf.buffers).toBeUndefined();
  });

  test("OBJ archive holds geometry, materials and vertex colours", () => {
    const files = unzipSync(writeObj([quad, painted], "model", "Title"));
    expect(Object.keys(files).sort()).toEqual(["model.mtl", "model.obj"]);
    const obj = strFromU8(files["model.obj"]!);
    const mtl = strFromU8(files["model.mtl"]!);
    expect(obj).toContain("mtllib model.mtl");
    expect(obj).toContain("o ground\nusemtl ground");
    expect(obj).toContain("v 2.000 0.000 -3.000\n");
    expect(obj).toContain("v 0.000 0.000 0.000 1.0000 0.0000 0.0000");
    // The second object indexes its own vertices, after the first one's four.
    expect(obj).toContain("f 5//5 6//6 7//7");
    expect(mtl).toContain("newmtl ground\nKd 1.0000 0.5020 0.0000");
    expect(mtl).toContain("newmtl buildings");
  });
});
