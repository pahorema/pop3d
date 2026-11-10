import { strToU8, zipSync } from "fflate";
import { averageColor, type Bytes, type ExportMesh, linearToSrgb, parseHex } from "./mesh";

const channel = (value: number) => Math.min(1, Math.max(0, value)).toFixed(4);

/**
 * Wavefront OBJ plus its material library, zipped together. Per-vertex colours (buildings,
 * trees) are written with the widely supported `v x y z r g b` extension.
 */
export function writeObj(meshes: ExportMesh[], slug: string, title: string): Bytes {
  const obj: string[] = [`# ${title} - pop3d\n# Units: metres, Y up\nmtllib ${slug}.mtl\n`];
  const mtl: string[] = [`# ${title} - pop3d\n`];
  let offset = 1;
  for (const mesh of meshes) {
    const { positions, normals, indices, colors } = mesh;
    if (!indices.length) continue;
    const lines: string[] = [`o ${mesh.name}\nusemtl ${mesh.name}\n`];

    // Materials take the flat colour, or the average of the vertex colours.
    const [r, g, b] = mesh.color
      ? parseHex(mesh.color)
      : averageColor(colors ?? new Float32Array()).map(linearToSrgb);
    mtl.push(
      `newmtl ${mesh.name}\nKd ${channel(r!)} ${channel(g!)} ${channel(b!)}\nKa 0 0 0\nKs 0.04 0.04 0.04\nNs ${Math.round((1 - mesh.roughness) * 200)}\nillum 2\n\n`,
    );

    for (let i = 0; i < positions.length; i += 3) {
      let line = `v ${positions[i]!.toFixed(3)} ${positions[i + 1]!.toFixed(3)} ${positions[i + 2]!.toFixed(3)}`;
      if (colors) {
        line += ` ${channel(linearToSrgb(colors[i]!))} ${channel(linearToSrgb(colors[i + 1]!))} ${channel(linearToSrgb(colors[i + 2]!))}`;
      }
      lines.push(line);
    }
    for (let i = 0; i < normals.length; i += 3) {
      lines.push(`vn ${normals[i]!.toFixed(3)} ${normals[i + 1]!.toFixed(3)} ${normals[i + 2]!.toFixed(3)}`);
    }
    for (let i = 0; i < indices.length; i += 3) {
      const a = indices[i]! + offset;
      const b2 = indices[i + 1]! + offset;
      const c = indices[i + 2]! + offset;
      lines.push(`f ${a}//${a} ${b2}//${b2} ${c}//${c}`);
    }
    offset += positions.length / 3;
    obj.push(lines.join("\n"), "\n");
  }
  const archive = zipSync(
    { [`${slug}.obj`]: strToU8(obj.join("")), [`${slug}.mtl`]: strToU8(mtl.join("")) },
    { level: 6 },
  );
  return archive as Bytes;
}
