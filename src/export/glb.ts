import { type Bytes, type ExportMesh, parseHex, srgbToLinear } from "./mesh";

const FLOAT = 5126;
const UNSIGNED_INT = 5125;
const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;

export interface GlbInfo {
  title: string;
  copyright?: string;
  /** Free-form metadata stored in the scene's `extras`. */
  extras?: Record<string, unknown>;
}

/**
 * Writes meshes as a binary glTF 2.0 file: one node, mesh and PBR material per mesh, with
 * vertex colours where present. Units are metres and Y is up, as the format prescribes.
 *
 * Written by hand rather than through a scene-graph exporter so that it runs anywhere,
 * including on a server without a DOM.
 */
export function writeGlb(meshes: ExportMesh[], info: GlbInfo): Bytes {
  const views: { bytes: Uint8Array; target: number }[] = [];
  const accessors: Record<string, unknown>[] = [];
  const bufferViews: Record<string, unknown>[] = [];
  let offset = 0;

  const add = (array: Float32Array | Uint32Array, type: string, target: number, bounds?: boolean): number => {
    const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.byteLength, target });
    views.push({ bytes, target });
    // Every view starts on a four-byte boundary, as required for float and int data.
    offset += Math.ceil(bytes.byteLength / 4) * 4;
    const size = type === "SCALAR" ? 1 : 3;
    const accessor: Record<string, unknown> = {
      bufferView: bufferViews.length - 1,
      componentType: array instanceof Uint32Array ? UNSIGNED_INT : FLOAT,
      count: array.length / size,
      type,
    };
    if (bounds) {
      const min = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
      const max = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
      for (let i = 0; i < array.length; i += 3) {
        for (let k = 0; k < 3; k++) {
          const value = array[i + k]!;
          if (value < min[k]!) min[k] = value;
          if (value > max[k]!) max[k] = value;
        }
      }
      accessor.min = min;
      accessor.max = max;
    }
    accessors.push(accessor);
    return accessors.length - 1;
  };

  const nodes: Record<string, unknown>[] = [];
  const gltfMeshes: Record<string, unknown>[] = [];
  const materials: Record<string, unknown>[] = [];
  for (const mesh of meshes) {
    if (!mesh.indices.length || !mesh.positions.length) continue;
    const attributes: Record<string, number> = {
      POSITION: add(mesh.positions, "VEC3", ARRAY_BUFFER, true),
      NORMAL: add(mesh.normals, "VEC3", ARRAY_BUFFER),
    };
    if (mesh.colors) attributes.COLOR_0 = add(mesh.colors, "VEC3", ARRAY_BUFFER);
    const indices = add(mesh.indices, "SCALAR", ELEMENT_ARRAY_BUFFER);
    const [r, g, b] = mesh.color ? parseHex(mesh.color).map(srgbToLinear) : [1, 1, 1];
    materials.push({
      name: mesh.name,
      pbrMetallicRoughness: {
        baseColorFactor: [r, g, b, 1],
        metallicFactor: mesh.metalness,
        roughnessFactor: mesh.roughness,
      },
    });
    gltfMeshes.push({
      name: mesh.name,
      primitives: [{ attributes, indices, material: materials.length - 1, mode: 4 }],
    });
    nodes.push({ name: mesh.name, mesh: gltfMeshes.length - 1 });
  }

  const gltf = {
    asset: { version: "2.0", generator: "pop3d", ...(info.copyright ? { copyright: info.copyright } : {}) },
    scene: 0,
    scenes: [
      { name: info.title, nodes: nodes.map((_, i) => i), ...(info.extras ? { extras: info.extras } : {}) },
    ],
    nodes,
    meshes: gltfMeshes,
    materials,
    accessors,
    bufferViews,
    buffers: [{ byteLength: offset }],
  };

  // The format forbids empty arrays: leave out whatever an empty model does not need.
  const document: Record<string, unknown> = { ...gltf };
  for (const key of Object.keys(document)) {
    if (Array.isArray(document[key]) && !(document[key] as unknown[]).length) delete document[key];
  }
  if (!offset) delete document.buffers;
  let json = new TextEncoder().encode(JSON.stringify(document));
  if (json.length % 4) {
    // JSON is padded with spaces, binary with zeros.
    const padded = new Uint8Array(Math.ceil(json.length / 4) * 4).fill(0x20);
    padded.set(json);
    json = padded;
  }
  const total = 12 + 8 + json.length + (offset ? 8 + offset : 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true); // "glTF"
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, json.length, true);
  view.setUint32(16, 0x4e4f534a, true); // "JSON"
  out.set(json, 20);
  if (offset) {
    const start = 20 + json.length;
    view.setUint32(start, offset, true);
    view.setUint32(start + 4, 0x004e4942, true); // "BIN"
    let cursor = start + 8;
    for (const { bytes } of views) {
      out.set(bytes, cursor);
      cursor += Math.ceil(bytes.byteLength / 4) * 4;
    }
  }
  return out;
}
