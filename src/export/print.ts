import { strToU8, zipSync } from "fflate";
import type { LayerId, PrintPart } from "../core/types";
import type { Bytes } from "./mesh";

/** Binary STL holding every part as one triangle soup. */
export function writeStl(parts: PrintPart[], title: string): Bytes {
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
  return new Uint8Array(buffer);
}

/**
 * Shortest decimal that reads back as the very same 32-bit float. Coordinates are written in
 * full: rounding them would merge corners a hair apart and tie shells in knots there.
 */
function exact(value: number): string {
  if (value === 0) return "0";
  for (let digits = 5; digits < 9; digits++) {
    const text = String(Number(value.toPrecision(digits)));
    if (Math.fround(Number(text)) === value) return text;
  }
  return String(Number(value.toPrecision(9)));
}

const xml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

/**
 * 3MF package with one object per part, each bound to its own colour.
 *
 * The layout is the one slicers actually act on: every part is a separate build item whose
 * `pid` points at a colour group of the Materials extension holding a single colour. Bambu
 * Studio and OrcaSlicer turn each distinct colour into a filament slot and, when asked to load
 * the file "as a single object with multiple parts", keep the parts aligned with their slot.
 * (Colours given as core `basematerials` on the components of one assembly are valid 3MF too,
 * but OrcaSlicer ignores them.)
 */
export function write3mf(
  parts: PrintPart[],
  colors: Record<LayerId, string>,
  names: Record<LayerId, string>,
  title: string,
): Bytes {
  const chunks: string[] = [];
  chunks.push(
    '<?xml version="1.0" encoding="UTF-8"?>\n',
    '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02">\n',
    ` <metadata name="Title">${xml(title)}</metadata>\n`,
    ' <metadata name="Application">pop3d</metadata>\n',
    " <resources>\n",
  );
  // Colour groups come first and in part order: slicers number filament slots in that order.
  parts.forEach((part, index) => {
    const color = (colors[part.layer] ?? "#cccccc").toUpperCase();
    chunks.push(`  <m:colorgroup id="${index + 1}"><m:color color="${color}FF"/></m:colorgroup>\n`);
  });

  const firstObject = parts.length + 1;
  parts.forEach((part, index) => {
    const t = part.triangles;
    // Weld corners that are exactly the same, one shell at a time: 3MF wants indexed meshes,
    // and shells that merely touch must not end up sharing an edge.
    const starts = new Set(part.shells);
    const lookup = new Map<string, number>();
    const vertices: string[] = [];
    const triangles: string[] = [];
    const corner = [0, 0, 0];
    for (let i = 0; i < t.length; i += 9) {
      if (starts.has(i / 9)) lookup.clear();
      for (let k = 0; k < 3; k++) {
        // Adding zero turns -0 into 0, which is the same corner.
        const x = t[i + k * 3]! + 0;
        const y = t[i + k * 3 + 1]! + 0;
        const z = t[i + k * 3 + 2]! + 0;
        const key = `${x} ${y} ${z}`;
        let id = lookup.get(key);
        if (id === undefined) {
          id = vertices.length;
          lookup.set(key, id);
          vertices.push(`<vertex x="${exact(x)}" y="${exact(y)}" z="${exact(z)}"/>`);
        }
        corner[k] = id;
      }
      if (corner[0] !== corner[1] && corner[1] !== corner[2] && corner[0] !== corner[2]) {
        triangles.push(`<triangle v1="${corner[0]}" v2="${corner[1]}" v3="${corner[2]}"/>`);
      }
    }
    chunks.push(
      `  <object id="${firstObject + index}" type="model" name="${xml(names[part.layer] ?? part.layer)}" pid="${index + 1}" pindex="0">\n   <mesh>\n    <vertices>\n`,
      vertices.join("\n"),
      "\n    </vertices>\n    <triangles>\n",
      triangles.join("\n"),
      "\n    </triangles>\n   </mesh>\n  </object>\n",
    );
  });

  chunks.push(" </resources>\n <build>\n");
  for (let index = 0; index < parts.length; index++) {
    chunks.push(`  <item objectid="${firstObject + index}"/>\n`);
  }
  chunks.push(" </build>\n</model>\n");

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
  return archive as Bytes;
}
