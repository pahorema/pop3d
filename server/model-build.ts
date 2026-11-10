import { DEFAULT_PRINT_LAYERS, type ModelOptions } from "../shared/model-api";
import { DEM_HEADER_BYTES, DEM_MAGIC, type OsmPayload } from "../shared/types";
import { type MessageKey, translate } from "../src/core/i18n";
import { type BuildParams, LAYERS, type LayerId } from "../src/core/types";
import { writeGlb } from "../src/export/glb";
import { type Bytes, MODEL_COPYRIGHT } from "../src/export/mesh";
import { writeObj } from "../src/export/obj";
import { write3mf, writeStl } from "../src/export/print";
import { Diorama } from "../src/scene/diorama";
import { LAYER_COLOR_KEY, resolveTheme, themeColor } from "../src/scene/themes";
import { buildDiorama, gridCells } from "../src/worker/build";
import { buildPrint } from "../src/worker/print";

/** One model to build, with its source data already fetched by the main thread. */
export interface ModelJob {
  id: number;
  options: ModelOptions & { lat: number; lon: number };
  title: string;
  slug: string;
  /** Gzip-compressed compact OSM payload. */
  osm: Uint8Array;
  /** Elevation grid as served by `/api/dem`, or `null` for a flat model. */
  elevation: Uint8Array | null;
}

/** Facts about a built model, returned alongside the file and by `format=json`. */
export interface ModelMeta {
  triangles: number;
  bottom: number;
  top: number;
  groundTop: number;
  layers: { id: string; triangles: number; color: string }[];
  stats: {
    buildings: number;
    trees: number;
    roadKm: number;
    elevation: [number, number];
    osmTimestamp: string;
  };
  /** Millimetres per metre and overall size, for print formats. */
  print?: { scale: number; ratio: number; width: number; depth: number; height: number };
  buildMs: number;
}

export type ModelReply =
  | { id: number; ok: true; meta: ModelMeta; body: Bytes }
  | { id: number; ok: false; message: string };

/** Builds one model from already-fetched source data. Pure and synchronous: meant for a worker. */
export function buildModel(job: ModelJob): { meta: ModelMeta; body: Bytes } {
  const started = performance.now();
  const { options } = job;
  const params: BuildParams = {
    area: {
      lat: options.lat,
      lon: options.lon,
      shape: options.shape,
      width: options.width,
      depth: options.depth,
    },
    detail: options.detail,
    relief: options.relief,
    roofs: options.roofs,
  };
  const osm = JSON.parse(new TextDecoder().decode(Bun.gunzipSync(job.osm as Bytes))) as OsmPayload;

  let elevation: Float32Array | null = null;
  if (job.elevation && params.relief > 0) {
    const size = gridCells(params) + 1;
    const header = new DataView(job.elevation.buffer, job.elevation.byteOffset, DEM_HEADER_BYTES);
    if (header.getUint32(0, true) === DEM_MAGIC && header.getUint32(4, true) === size) {
      // Copy out of the message buffer so that the grid starts on a four-byte boundary.
      elevation = new Float32Array(
        job.elevation.slice(DEM_HEADER_BYTES, DEM_HEADER_BYTES + size * size * 4).buffer,
      );
    }
  }

  const { data, state } = buildDiorama(params, osm, elevation, () => {});
  const theme = resolveTheme(options.theme, options.colors);
  const hidden = new Set(options.hide);
  const wanted = (layer: LayerId) =>
    (options.layers ? options.layers.includes(layer) : true) && !hidden.has(layer);

  const meta: ModelMeta = {
    triangles: 0,
    bottom: data.bottomY,
    top: data.topY,
    groundTop: data.groundTopY,
    layers: [],
    stats: {
      buildings: data.stats.buildings,
      trees: data.stats.trees,
      roadKm: Math.round(data.stats.roadKm * 100) / 100,
      elevation: [
        Math.round(data.stats.elevation[0] * 10) / 10,
        Math.round(data.stats.elevation[1] * 10) / 10,
      ],
      osmTimestamp: data.stats.osmTimestamp,
    },
    buildMs: 0,
  };
  let body: Bytes = new Uint8Array(0);

  if (options.format === "stl" || options.format === "3mf") {
    const layers = (
      options.layers ? (["base", ...options.layers] as LayerId[]) : DEFAULT_PRINT_LAYERS
    ).filter((layer) => layer === "base" || !hidden.has(layer));
    const { parts, scale } = buildPrint(state, {
      sizeMm: options.printSize,
      baseMm: options.printBase,
      zScale: options.printZScale,
      minFeatureMm: options.printFeature,
      layers,
    });
    const colors = {} as Record<LayerId, string>;
    const names = {} as Record<LayerId, string>;
    for (const layer of LAYERS) {
      colors[layer] = themeColor(theme, LAYER_COLOR_KEY[layer]);
      names[layer] = translate(options.lang, `layer.${layer}` as MessageKey);
    }
    for (const part of parts) {
      const triangles = part.triangles.length / 9;
      meta.layers.push({ id: part.layer, triangles, color: colors[part.layer] });
      meta.triangles += triangles;
    }
    meta.print = {
      scale,
      ratio: Math.round(1000 / scale),
      width: Math.round(options.width * scale * 10) / 10,
      depth: Math.round(options.depth * scale * 10) / 10,
      height: Math.round((options.printBase + data.topY * scale * options.printZScale) * 10) / 10,
    };
    body = options.format === "stl" ? writeStl(parts, job.title) : write3mf(parts, colors, names, job.title);
  } else {
    const diorama = new Diorama(data, {
      theme,
      buildingColors: options.buildings,
      edges: false,
      faceted: false,
    });
    const visibility = {} as Record<LayerId, boolean>;
    for (const layer of LAYERS) visibility[layer] = wanted(layer);
    diorama.setVisibility(visibility, null);
    const meshes = diorama.exportMeshes();
    for (const mesh of meshes) {
      const triangles = mesh.indices.length / 3;
      const layer = mesh.name.split("-")[0] as LayerId;
      meta.layers.push({
        id: mesh.name,
        triangles,
        color: mesh.color ?? themeColor(theme, LAYER_COLOR_KEY[layer]),
      });
      meta.triangles += triangles;
    }
    if (options.format === "glb") {
      body = writeGlb(meshes, {
        title: job.title,
        copyright: MODEL_COPYRIGHT,
        extras: {
          latitude: options.lat,
          longitude: options.lon,
          shape: options.shape,
          width: options.width,
          depth: options.depth,
          relief: options.relief,
          elevation: meta.stats.elevation,
        },
      });
    } else if (options.format === "obj") {
      body = writeObj(meshes, job.slug, job.title);
    }
  }
  meta.buildMs = Math.round(performance.now() - started);
  return { meta, body };
}
