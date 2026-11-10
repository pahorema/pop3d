import { describe, expect, test } from "bun:test";
import { strFromU8, unzipSync } from "fflate";
import { docsPage, ENDPOINTS, openApiDocument } from "../server/api-docs";
import { parseModelOptions } from "../server/model";
import { buildModel, type ModelJob } from "../server/model-build";
import { MODEL_DEFAULTS, MODEL_FORMATS, type ModelOptions, modelQuery } from "../shared/model-api";
import { OSM_COORD_SCALE, type OsmPayload, type OsmTags } from "../shared/types";
import { projector } from "../src/geo/projection";

const parse = (query: string) => parseModelOptions(new URLSearchParams(query));

describe("model request parameters", () => {
  test("defaults apply when only a place is given", () => {
    expect(parse("lat=45.65&lon=13.77")).toEqual({ ...MODEL_DEFAULTS, q: undefined, lat: 45.65, lon: 13.77 });
    expect(parse("q=Trieste").q).toBe("Trieste");
    // Coordinates win over a place name.
    expect(parse("q=Trieste&lat=1&lon=2").q).toBeUndefined();
  });

  test("size, width and depth combine sensibly", () => {
    expect(parse("q=x&size=500")).toMatchObject({ width: 500, depth: 500 });
    expect(parse("q=x&width=900&depth=400")).toMatchObject({ width: 900, depth: 400 });
    expect(parse("q=x&width=900")).toMatchObject({ width: 900, depth: 900 });
    expect(parse("q=x&size=500&depth=300")).toMatchObject({ width: 500, depth: 300 });
  });

  test("every option is read and normalised", () => {
    const options = parse(
      "lat=40.7&lon=-74&shape=hexagon&detail=2&relief=2.5&roofs=false&format=3mf&theme=notte&buildings=kind" +
        "&colors=walls:FFF,roofs:%23c8553d&layers=buildings,roads,roads&hide=trees&print_size=100&print_base=2" +
        "&print_zscale=2&print_feature=0.6&lang=it&download=1",
    );
    expect(options).toMatchObject({
      shape: "hexagon",
      detail: 2,
      relief: 2.5,
      roofs: false,
      format: "3mf",
      theme: "notte",
      buildings: "kind",
      colors: { walls: "#ffffff", roofs: "#c8553d" },
      layers: ["buildings", "roads"],
      hide: ["trees"],
      printSize: 100,
      printBase: 2,
      printZScale: 2,
      printFeature: 0.6,
      lang: "it",
      download: true,
    });
  });

  test("bad input is refused with a message naming the parameter", () => {
    const cases: [string, string][] = [
      ["", "Say where"],
      ["lat=45", '"lon"'],
      ["q=x&size=10", '"size"'],
      ["q=x&relief=9", '"relief"'],
      ["q=x&shape=star", '"shape"'],
      ["q=x&detail=3", '"detail"'],
      ["q=x&format=dwg", '"format"'],
      ["q=x&theme=neon", '"theme"'],
      ["q=x&colors=walls:zzz", '"colors"'],
      ["q=x&colors=sky:fff", '"colors"'],
      ["q=x&layers=cats", '"layers"'],
      ["q=x&roofs=maybe", '"roofs"'],
      ["q=x&print_size=5", '"print_size"'],
    ];
    for (const [query, expected] of cases) {
      expect(() => parse(query), query).toThrow(expected);
    }
  });

  test("links built by the app parse back to the same options", () => {
    const options: ModelOptions = {
      ...MODEL_DEFAULTS,
      lat: 45.6503,
      lon: 13.7678,
      shape: "rounded",
      width: 900,
      depth: 600,
      detail: 2,
      relief: 1.4,
      roofs: false,
      format: "stl",
      theme: "plastico",
      colors: { water: "#3388aa", roofs: "#c8553d" },
      buildings: "height",
      layers: ["buildings", "roads"],
      hide: ["trees"],
      printSize: 120,
      printBase: 2.5,
      printZScale: 2,
      printFeature: 0.5,
      lang: "it",
      download: true,
    };
    expect(parse(modelQuery(options))).toEqual({ ...options, q: undefined });
    // Defaults are left out of the address.
    expect(modelQuery({ lat: 1, lon: 2 })).toBe("lat=1.00000&lon=2.00000");
  });
});

describe("documentation", () => {
  test("every documented model parameter is one the parser accepts", () => {
    const model = ENDPOINTS.find((endpoint) => endpoint.path === "/api/model")!;
    for (const param of model.groups.flatMap((group) => group.params)) {
      const value =
        param.example ?? param.values?.[0] ?? param.min ?? (param.type === "boolean" ? "true" : "x");
      const query = new URLSearchParams({ lat: "45", lon: "13", [param.name]: String(value) });
      if (param.name === "q") {
        query.delete("lat");
        query.delete("lon");
      }
      expect(() => parseModelOptions(query), param.name).not.toThrow();
    }
  });

  test("OpenAPI and the docs page cover every endpoint", () => {
    const spec = openApiDocument("https://example.org") as any;
    expect(spec.openapi).toBe("3.1.0");
    expect(spec.servers).toEqual([{ url: "https://example.org" }]);
    const page = docsPage("https://example.org");
    for (const endpoint of ENDPOINTS) {
      expect(spec.paths[endpoint.path].get.summary).toBe(endpoint.summary);
      expect(page.includes(`id="${endpoint.path.replace("/api/", "")}"`)).toBe(true);
    }
    const names = spec.paths["/api/model"].get.parameters.map((p: { name: string }) => p.name);
    expect(names).toContain("print_zscale");
    expect(new Set(names).size).toBe(names.length);
    expect(spec.paths["/api/model"].get.parameters.find((p: any) => p.name === "format").schema.enum).toEqual(
      [...MODEL_FORMATS],
    );
    // Checked as a boolean so that a failure does not print the whole page.
    expect(page.includes("curl -o trieste.glb &quot;https://example.org/api/model?")).toBe(true);
  });
});

describe("model builds", () => {
  const LAT = 45.65;
  const LON = 13.77;
  const projection = projector(LAT, LON);
  const origin = { lat: LAT - 0.02, lon: LON - 0.02 };
  const encode = (points: number[]) => {
    const out: number[] = [];
    for (let i = 0; i < points.length; i += 2) {
      const [lat, lon] = projection.toGeo(points[i]!, points[i + 1]!);
      out.push(
        Math.round((lat - origin.lat) * OSM_COORD_SCALE),
        Math.round((lon - origin.lon) * OSM_COORD_SCALE),
      );
    }
    return out;
  };
  let id = 1;
  const way = (tags: OsmTags, points: number[]) => ({ id: id++, tags, g: encode(points) });
  const payload: OsmPayload = {
    v: 1,
    timestamp: "2026-01-01T00:00:00Z",
    origin,
    nodes: [{ id: 900, tags: { natural: "tree" }, p: encode([-60, 80]) as [number, number] }],
    ways: [
      way({ building: "house", name: "Casa" }, [-40, -30, -18, -30, -18, -16, -40, -16, -40, -30]),
      way({ building: "yes", height: "30" }, [20, 10, 50, 10, 50, 40, 20, 40, 20, 10]),
      way({ highway: "residential" }, [-190, -60, 190, -60]),
      way({ natural: "water" }, [-150, 60, -90, 50, -70, 110, -130, 130, -150, 60]),
      way({ leisure: "park" }, [60, -150, 150, -150, 150, -80, 60, -80, 60, -150]),
    ],
    relations: [],
  };
  const osm = Bun.gzipSync(new TextEncoder().encode(JSON.stringify(payload)));
  const job = (overrides: Partial<ModelOptions>): ModelJob => ({
    id: 1,
    options: {
      ...MODEL_DEFAULTS,
      lat: LAT,
      lon: LON,
      width: 400,
      depth: 400,
      relief: 0,
      ...overrides,
    } as ModelJob["options"],
    title: "Test place",
    slug: "pop3d-test",
    osm,
    elevation: null,
  });

  test("glb holds every layer, coloured, with the place in its metadata", () => {
    const { meta, body } = buildModel(job({ format: "glb" }));
    const view = new DataView(body.buffer, body.byteOffset);
    expect(view.getUint32(0, true)).toBe(0x46546c67);
    const gltf = JSON.parse(new TextDecoder().decode(body.subarray(20, 20 + view.getUint32(12, true))));
    const names = gltf.nodes.map((node: { name: string }) => node.name);
    for (const name of ["base", "ground", "water", "green", "roads", "buildings", "trees-crowns"]) {
      expect(names).toContain(name);
    }
    expect(gltf.scenes[0].name).toBe("Test place");
    expect(gltf.scenes[0].extras).toMatchObject({ latitude: LAT, longitude: LON, width: 400 });
    expect(gltf.asset.copyright).toContain("OpenStreetMap");
    expect(meta.stats.buildings).toBe(2);
    expect(meta.triangles).toBe(meta.layers.reduce((sum, layer) => sum + layer.triangles, 0));
    expect(meta.top).toBeGreaterThan(29);
  });

  test("layers and hide select what goes into the model", () => {
    const only = buildModel(job({ format: "json", layers: ["buildings", "ground"] }));
    expect(only.meta.layers.map((layer) => layer.id)).toEqual(["ground", "buildings"]);
    expect(only.body.length).toBe(0);
    const without = buildModel(job({ format: "json", hide: ["trees", "water"] }));
    const ids = without.meta.layers.map((layer) => layer.id);
    expect(ids).not.toContain("water");
    expect(ids).not.toContain("trees-crowns");
    expect(ids).toContain("buildings");
  });

  test("themes and colour overrides reach the materials", () => {
    const { meta } = buildModel(job({ format: "json", theme: "notte", colors: { water: "#123456" } }));
    expect(meta.layers.find((layer) => layer.id === "water")!.color).toBe("#123456");
    expect(meta.layers.find((layer) => layer.id === "roads")!.color).toBe("#4c5d8c");
  });

  test("print formats come out scaled, with their parts", () => {
    const stl = buildModel(job({ format: "stl", printSize: 100, printBase: 2 }));
    const triangles = new DataView(stl.body.buffer, stl.body.byteOffset).getUint32(80, true);
    expect(stl.body.length).toBe(84 + triangles * 50);
    expect(triangles).toBe(stl.meta.triangles);
    expect(stl.meta.print).toMatchObject({ scale: 0.25, ratio: 4000, width: 100, depth: 100 });
    expect(stl.meta.layers.map((layer) => layer.id)).toEqual(["base", "water", "roads", "buildings"]);

    const mf = buildModel(job({ format: "3mf", lang: "it", layers: ["buildings", "green"] }));
    const model = strFromU8(unzipSync(mf.body)["3D/3dmodel.model"]!);
    expect(model).toContain('name="Edifici"');
    expect(model).toContain('name="Prati e parchi"');
    expect(model).not.toContain('name="Strade"');
    expect(model.match(/<object /g)).toHaveLength(mf.meta.layers.length + 1);
  });

  test("obj comes as a zip named after the place", () => {
    const { body } = buildModel(job({ format: "obj" }));
    expect(Object.keys(unzipSync(body)).sort()).toEqual(["pop3d-test.mtl", "pop3d-test.obj"]);
  });
});
