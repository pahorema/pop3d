import { strToU8, zipSync } from "fflate";
import type { LayerId, PrintPart } from "../core/types";

/** Binary STL holding every part as one triangle soup. */
export function writeStl(parts: PrintPart[], title: string): Blob {
  let count = 0;
  for (const part of parts) count += part.triangles.length / 9;
  const buffer = new ArrayBuffer(84 + count * 50);
  const view = new DataView(buffer);
  const header = strToU8(`${title} - pop3d`.slice(0, 79));
  new Uint8Array(buffer, 0, 80).set(header);
  view.setUint32(80, count, true);
  let offset = 84;
  for (const part of parts) {
    const t = part.triangles;
    for (let i = 0; i < t.length; i += 9) {
      const ux = t[i + 3]! - t[i]!;
      const uy = t[i + 4]! - t[i + 1]!;
      const uz = t[i + 5]! - t[i + 2]!;
      const vx = t[i + 6]! - t[i]!;
      const vy = t[i + 7]! - t[i + 1]!;
      const vz = t[i + 8]! - t[i + 2]!;
      let nx = uy * vz - uz * vy;
      let ny = uz * vx - ux * vz;
      let nz = ux * vy - uy * vx;
      const length = Math.hypot(nx, ny, nz) || 1;
      nx /= length;
      ny /= length;
      nz /= length;
      view.setFloat32(offset, nx, true);
      view.setFloat32(offset + 4, ny, true);
      view.setFloat32(offset + 8, nz, true);
      for (let k = 0; k < 9; k++) view.setFloat32(offset + 12 + k * 4, t[i + k]!, true);
      offset += 50;
    }
  }
  return new Blob([buffer], { type: "model/stl" });
}

const xml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

/**
 * 3MF package with one object per part, each with its own base material, grouped as components
 * of a single printable item. Slicers open it as one model with separately colourable parts.
 */
export function write3mf(
  parts: PrintPart[],
  colors: Record<LayerId, string>,
  names: Record<LayerId, string>,
  title: string,
): Blob {
  const chunks: string[] = [];
  chunks.push(
    '<?xml version="1.0" encoding="UTF-8"?>\n',
    '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n',
    ` <metadata name="Title">${xml(title)}</metadata>\n`,
    ' <metadata name="Application">pop3d</metadata>\n',
    " <resources>\n",
    '  <basematerials id="1">\n',
  );
  for (const part of parts) {
    const color = (colors[part.layer] ?? "#cccccc").toUpperCase();
    chunks.push(`   <base name="${xml(names[part.layer] ?? part.layer)}" displaycolor="${color}FF"/>\n`);
  }
  chunks.push("  </basematerials>\n");

  parts.forEach((part, index) => {
    const t = part.triangles;
    // Weld identical corners: 3MF wants indexed meshes and slicers need shared vertices.
    const lookup = new Map<string, number>();
    const vertices: string[] = [];
    const triangles: string[] = [];
    const corner = [0, 0, 0];
    for (let i = 0; i < t.length; i += 9) {
      for (let k = 0; k < 3; k++) {
        const x = t[i + k * 3]!.toFixed(3);
        const y = t[i + k * 3 + 1]!.toFixed(3);
        const z = t[i + k * 3 + 2]!.toFixed(3);
        const key = `${x} ${y} ${z}`;
        let id = lookup.get(key);
        if (id === undefined) {
          id = lookup.size;
          lookup.set(key, id);
          vertices.push(`<vertex x="${x}" y="${y}" z="${z}"/>`);
        }
        corner[k] = id;
      }
      if (corner[0] !== corner[1] && corner[1] !== corner[2] && corner[0] !== corner[2]) {
        triangles.push(`<triangle v1="${corner[0]}" v2="${corner[1]}" v3="${corner[2]}"/>`);
      }
    }
    chunks.push(
      `  <object id="${index + 2}" type="model" name="${xml(names[part.layer] ?? part.layer)}" pid="1" pindex="${index}">\n   <mesh>\n    <vertices>\n`,
      vertices.join("\n"),
      "\n    </vertices>\n    <triangles>\n",
      triangles.join("\n"),
      "\n    </triangles>\n   </mesh>\n  </object>\n",
    );
  });

  const assembly = parts.length + 2;
  chunks.push(`  <object id="${assembly}" type="model" name="${xml(title)}">\n   <components>\n`);
  parts.forEach((_, index) => chunks.push(`    <component objectid="${index + 2}"/>\n`));
  chunks.push(
    "   </components>\n  </object>\n </resources>\n",
    ` <build>\n  <item objectid="${assembly}"/>\n </build>\n</model>\n`,
  );

  const archive = zipSync(
    {
      "[Content_Types].xml": strToU8(
        '<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>',
      ),
      "_rels/.rels": strToU8(
        '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>',
      ),
      "3D/3dmodel.model": strToU8(chunks.join("")),
    },
    { level: 6 },
  );
  return new Blob([archive.buffer as ArrayBuffer], { type: "model/3mf" });
}
