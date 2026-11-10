/** A plain triangle mesh ready to be written to a file, free of any rendering library. */
export interface ExportMesh {
  name: string;
  /** x, y, z triplets in metres: x east, y up, z south. */
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  /** Linear RGB per vertex, for meshes that are not one flat colour. */
  colors?: Float32Array;
  /** Flat colour as `#rrggbb`, or `null` when `colors` is used instead. */
  color: string | null;
  roughness: number;
  metalness: number;
}

export type Bytes = Uint8Array<ArrayBuffer>;

/** Attribution embedded in exported models, as the data licences ask. */
export const MODEL_COPYRIGHT =
  "Map data © OpenStreetMap contributors (ODbL). Elevation: Mapzen Terrain Tiles. Model by pop3d.";

/** One sRGB channel (0..1) to linear light. */
export function srgbToLinear(value: number): number {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

/** One linear channel (0..1) to sRGB. */
export function linearToSrgb(value: number): number {
  const v = Math.min(1, Math.max(0, value));
  return v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
}

/** `#rgb` or `#rrggbb` to sRGB channels in 0..1. */
export function parseHex(hex: string): [number, number, number] {
  let text = hex.trim().replace(/^#/, "");
  if (text.length === 3) text = [...text].map((c) => c + c).join("");
  const value = Number.parseInt(text, 16);
  if (text.length !== 6 || !Number.isFinite(value)) return [0.8, 0.8, 0.8];
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}

/** Average of a mesh's vertex colours, in linear RGB. */
export function averageColor(colors: Float32Array): [number, number, number] {
  let r = 0;
  let g = 0;
  let b = 0;
  const count = colors.length / 3;
  for (let i = 0; i < colors.length; i += 3) {
    r += colors[i]!;
    g += colors[i + 1]!;
    b += colors[i + 2]!;
  }
  return count ? [r / count, g / count, b / count] : [0.8, 0.8, 0.8];
}
