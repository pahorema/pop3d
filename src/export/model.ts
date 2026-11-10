import { strToU8, zipSync } from "fflate";
import * as THREE from "three";
import type { ExportMesh } from "../scene/diorama";

/** Binary glTF with one named, coloured mesh per layer. Units are metres, Y is up. */
export async function writeGlb(meshes: ExportMesh[], title: string): Promise<Blob> {
  const { GLTFExporter } = await import("three/addons/exporters/GLTFExporter.js");
  const scene = new THREE.Scene();
  scene.name = title;
  for (const item of meshes) {
    const material = new THREE.MeshStandardMaterial({
      name: item.name,
      color: item.color ?? "#ffffff",
      vertexColors: item.color === null,
      roughness: item.roughness,
      metalness: item.metalness,
    });
    const mesh = new THREE.Mesh(item.geometry, material);
    mesh.name = item.name;
    scene.add(mesh);
  }
  const buffer = (await new GLTFExporter().parseAsync(scene, { binary: true })) as ArrayBuffer;
  scene.traverse((object) => ((object as THREE.Mesh).material as THREE.Material | undefined)?.dispose());
  return new Blob([buffer], { type: "model/gltf-binary" });
}

const channel = (value: number) => THREE.MathUtils.clamp(value, 0, 1).toFixed(4);

/**
 * Wavefront OBJ plus its material library, zipped together. Per-vertex colours (buildings,
 * trees) are written with the widely supported `v x y z r g b` extension.
 */
export function writeObj(meshes: ExportMesh[], slug: string, title: string): Blob {
  const obj: string[] = [`# ${title} - pop3d\n# Units: metres, Y up\nmtllib ${slug}.mtl\n`];
  const mtl: string[] = [`# ${title} - pop3d\n`];
  const color = new THREE.Color();
  let offset = 1;
  for (const item of meshes) {
    const position = item.geometry.getAttribute("position");
    const normal = item.geometry.getAttribute("normal");
    const colors = item.color === null ? item.geometry.getAttribute("color") : null;
    const index = item.geometry.getIndex();
    if (!index) continue;
    const lines: string[] = [`o ${item.name}\nusemtl ${item.name}\n`];

    // Materials take the flat colour, or the average of the vertex colours.
    if (item.color) color.set(item.color);
    else if (colors) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let i = 0; i < colors.count; i++) {
        r += colors.getX(i);
        g += colors.getY(i);
        b += colors.getZ(i);
      }
      color.setRGB(r / colors.count, g / colors.count, b / colors.count);
    }
    const srgb = color.clone().convertLinearToSRGB();
    mtl.push(
      `newmtl ${item.name}\nKd ${channel(srgb.r)} ${channel(srgb.g)} ${channel(srgb.b)}\nKa 0 0 0\nKs 0.04 0.04 0.04\nNs ${Math.round((1 - item.roughness) * 200)}\nillum 2\n\n`,
    );

    const vertex = new THREE.Color();
    for (let i = 0; i < position.count; i++) {
      let line = `v ${position.getX(i).toFixed(3)} ${position.getY(i).toFixed(3)} ${position.getZ(i).toFixed(3)}`;
      if (colors) {
        vertex.setRGB(colors.getX(i), colors.getY(i), colors.getZ(i)).convertLinearToSRGB();
        line += ` ${channel(vertex.r)} ${channel(vertex.g)} ${channel(vertex.b)}`;
      }
      lines.push(line);
    }
    for (let i = 0; i < normal.count; i++) {
      lines.push(`vn ${normal.getX(i).toFixed(3)} ${normal.getY(i).toFixed(3)} ${normal.getZ(i).toFixed(3)}`);
    }
    for (let i = 0; i < index.count; i += 3) {
      const a = index.getX(i) + offset;
      const b = index.getX(i + 1) + offset;
      const c = index.getX(i + 2) + offset;
      lines.push(`f ${a}//${a} ${b}//${b} ${c}//${c}`);
    }
    offset += position.count;
    obj.push(lines.join("\n"), "\n");
  }
  const archive = zipSync(
    { [`${slug}.obj`]: strToU8(obj.join("")), [`${slug}.mtl`]: strToU8(mtl.join("")) },
    { level: 6 },
  );
  return new Blob([archive.buffer as ArrayBuffer], { type: "application/zip" });
}
