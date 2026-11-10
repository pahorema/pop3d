import {
  DEFAULT_PRINT_LAYERS,
  MODEL_BUILDING_COLORS,
  MODEL_DEFAULTS,
  MODEL_FORMATS,
  MODEL_LIMITS,
  MODEL_SHAPES,
} from "../shared/model-api";
import { LAYERS } from "../src/core/types";
import { COLOR_KEYS, THEMES } from "../src/scene/themes";
import { config } from "./config";

interface Param {
  name: string;
  type: "number" | "integer" | "string" | "boolean";
  description: string;
  default?: string | number | boolean;
  values?: readonly (string | number)[];
  min?: number;
  max?: number;
  required?: boolean;
  example?: string | number;
}

interface Group {
  title: string;
  params: Param[];
}

interface Endpoint {
  path: string;
  summary: string;
  description: string;
  groups: Group[];
  returns: string;
  examples: { label: string; query: string }[];
}

const d = MODEL_DEFAULTS;
const bbox: Param[] = [
  { name: "s", type: "number", description: "Southern edge, degrees of latitude.", required: true },
  { name: "w", type: "number", description: "Western edge, degrees of longitude.", required: true },
  { name: "n", type: "number", description: "Northern edge, degrees of latitude.", required: true },
  { name: "e", type: "number", description: "Eastern edge, degrees of longitude.", required: true },
];
const lang: Param = {
  name: "lang",
  type: "string",
  description: "Language of place names. Defaults to the Accept-Language header.",
  example: "it",
};

export const ENDPOINTS: Endpoint[] = [
  {
    path: "/api/model",
    summary: "A finished 3D model of any place",
    description:
      "Builds the diorama of a place on the server and returns it as a file. Say where with coordinates or a place name, then shape, style and format it with the options below. Results are cached: asking again for the same model is immediate.",
    returns:
      "The model file in the requested format, or a JSON description of it with <code>format=json</code>. Response headers carry <code>X-Pop3d-Center</code>, <code>X-Pop3d-Place</code>, <code>X-Pop3d-Triangles</code> and, for prints, <code>X-Pop3d-Print-Scale</code>.",
    groups: [
      {
        title: "Where",
        params: [
          {
            name: "q",
            type: "string",
            description:
              "A place name, address or postcode. The first geocoding match is used. Ignored when coordinates are given.",
            example: "Colosseo, Roma",
          },
          {
            name: "lat",
            type: "number",
            description: "Latitude of the centre.",
            min: -85,
            max: 85,
            example: 45.6503,
          },
          {
            name: "lon",
            type: "number",
            description: "Longitude of the centre.",
            min: -180,
            max: 180,
            example: 13.7678,
          },
        ],
      },
      {
        title: "Area",
        params: [
          {
            name: "shape",
            type: "string",
            description: "Outline of the model.",
            values: MODEL_SHAPES,
            default: d.shape,
          },
          {
            name: "size",
            type: "number",
            description: "Extent in metres, for both sides (the diameter of a circle).",
            min: MODEL_LIMITS.size[0],
            max: MODEL_LIMITS.size[1],
            default: d.width,
          },
          {
            name: "width",
            type: "number",
            description: "East-west extent in metres, to give the two sides separately.",
            min: MODEL_LIMITS.size[0],
            max: MODEL_LIMITS.size[1],
          },
          {
            name: "depth",
            type: "number",
            description: "North-south extent in metres.",
            min: MODEL_LIMITS.size[0],
            max: MODEL_LIMITS.size[1],
          },
        ],
      },
      {
        title: "Content",
        params: [
          {
            name: "detail",
            type: "integer",
            description:
              "0 keeps buildings, main roads, water and greenery; 1 adds minor roads, paths, trees and 3D building parts; 2 adds sidewalks, service tracks and denser woods.",
            values: [0, 1, 2],
            default: d.detail,
          },
          {
            name: "relief",
            type: "number",
            description: "Vertical exaggeration of the terrain: 0 is flat, 1 is true to scale.",
            min: MODEL_LIMITS.relief[0],
            max: MODEL_LIMITS.relief[1],
            default: d.relief,
          },
          {
            name: "roofs",
            type: "boolean",
            description: "Pitched roofs and domes, from the data or inferred from the footprint.",
            default: d.roofs,
          },
          {
            name: "layers",
            type: "string",
            description: `Comma-separated layers to keep; everything else is left out. For prints the plinth is always included and the default is ${DEFAULT_PRINT_LAYERS.filter((l) => l !== "base").join(", ")}.`,
            values: LAYERS,
            example: "buildings,roads,water",
          },
          {
            name: "hide",
            type: "string",
            description: "Comma-separated layers to leave out.",
            values: LAYERS,
            example: "trees,urban",
          },
        ],
      },
      {
        title: "Style",
        params: [
          {
            name: "theme",
            type: "string",
            description: "Colour scheme.",
            values: THEMES.map((theme) => theme.id),
            default: d.theme,
          },
          {
            name: "colors",
            type: "string",
            description: `Overrides on top of the theme, as comma-separated <code>key:hex</code> pairs. Keys: ${COLOR_KEYS.filter((key) => key !== "background").join(", ")}.`,
            example: "walls:f2e9dc,roofs:c8553d,water:7fc4de",
          },
          {
            name: "buildings",
            type: "string",
            description:
              "How buildings are coloured: by the theme, by their height, or by what they are used for.",
            values: MODEL_BUILDING_COLORS,
            default: d.buildings,
          },
        ],
      },
      {
        title: "Printing (stl, 3mf)",
        params: [
          {
            name: "print_size",
            type: "number",
            description: "Longest side of the printed model, in millimetres. This sets the scale.",
            min: MODEL_LIMITS.printSize[0],
            max: MODEL_LIMITS.printSize[1],
            default: d.printSize,
          },
          {
            name: "print_base",
            type: "number",
            description: "Thickness of the plinth under the lowest ground, in millimetres.",
            min: MODEL_LIMITS.printBase[0],
            max: MODEL_LIMITS.printBase[1],
            default: d.printBase,
          },
          {
            name: "print_zscale",
            type: "number",
            description: "Extra vertical exaggeration, so that buildings and relief read at small scale.",
            min: MODEL_LIMITS.printZScale[0],
            max: MODEL_LIMITS.printZScale[1],
            default: d.printZScale,
          },
          {
            name: "print_feature",
            type: "number",
            description: "Smallest printable feature in millimetres: thinner details are thickened.",
            min: MODEL_LIMITS.printFeature[0],
            max: MODEL_LIMITS.printFeature[1],
            default: d.printFeature,
          },
        ],
      },
      {
        title: "Delivery",
        params: [
          {
            name: "format",
            type: "string",
            description:
              "<code>glb</code> binary glTF with colours; <code>obj</code> a zip with OBJ and MTL; <code>stl</code> one watertight solid; <code>3mf</code> watertight parts, one object and one colour each (Bambu Studio and OrcaSlicer map them to filaments); <code>json</code> a description of the model with links to every format.",
            values: MODEL_FORMATS,
            default: d.format,
          },
          {
            name: "lang",
            type: "string",
            description: "Language for geocoding and for part names in 3MF files.",
            values: ["it", "en"],
            default: d.lang,
          },
          {
            name: "download",
            type: "boolean",
            description: "Send the file as an attachment, so that browsers save it instead of showing it.",
            default: d.download,
          },
        ],
      },
    ],
    examples: [
      { label: "Trieste, as a glTF model", query: "lat=45.6503&lon=13.7678" },
      {
        label: "The Colosseum by name, 600 m wide, white scale-model look",
        query: "q=Colosseo, Roma&size=600&theme=plastico",
      },
      {
        label: "Hallstatt as a 120 mm print with exaggerated relief",
        query: "q=Hallstatt&size=1000&format=stl&print_size=120&print_zscale=2",
      },
      {
        label: "Only buildings and roads of Midtown Manhattan, coloured by height",
        query:
          "lat=40.7484&lon=-73.9857&size=900&shape=square&layers=buildings,roads,ground,base&buildings=height",
      },
      {
        label: "What a model contains, without downloading it",
        query: "q=Mont-Saint-Michel&relief=1.5&format=json",
      },
    ],
  },
  {
    path: "/api/geocode",
    summary: "Find places by name, address or postcode",
    description: "Full forward geocoding, for when the user has finished typing.",
    returns:
      "An array of places: <code>id, name, detail, lat, lon, kind</code> and, when known, <code>span</code> in metres.",
    groups: [
      {
        title: "Parameters",
        params: [
          { name: "q", type: "string", description: "What to look for.", required: true, example: "34121" },
          lang,
        ],
      },
    ],
    examples: [{ label: "A postcode", query: "q=34121&lang=it" }],
  },
  {
    path: "/api/suggest",
    summary: "Search-as-you-type suggestions",
    description:
      "Quick, typo-tolerant suggestions for partial input, optionally favouring results near a point.",
    returns: "An array of places, like <code>/api/geocode</code>.",
    groups: [
      {
        title: "Parameters",
        params: [
          {
            name: "q",
            type: "string",
            description: "What the user typed so far.",
            required: true,
            example: "piazza un",
          },
          { name: "lat", type: "number", description: "Latitude to favour results around." },
          { name: "lon", type: "number", description: "Longitude to favour results around." },
          lang,
        ],
      },
    ],
    examples: [{ label: "Partial input near Trieste", query: "q=piazza un&lat=45.65&lon=13.77" }],
  },
  {
    path: "/api/reverse",
    summary: "Name the place at given coordinates",
    description: "Reverse geocoding at roughly street level.",
    returns: "One place, or <code>null</code> when nothing is there.",
    groups: [
      {
        title: "Parameters",
        params: [
          { name: "lat", type: "number", description: "Latitude.", required: true, example: 45.6503 },
          { name: "lon", type: "number", description: "Longitude.", required: true, example: 13.7678 },
          lang,
        ],
      },
    ],
    examples: [{ label: "A point in Trieste", query: "lat=45.6503&lon=13.7678" }],
  },
  {
    path: "/api/osm",
    summary: "Raw map data of a bounding box",
    description:
      "The OpenStreetMap extract the models are built from, in a compact JSON: coordinates are integers in 1e-7 degrees relative to <code>origin</code>, flattened as <code>[lat, lon, lat, lon, …]</code>, and only the tags the builder reads are kept.",
    returns: "<code>{ v, timestamp, origin, nodes, ways, relations }</code>.",
    groups: [{ title: "Parameters", params: bbox }],
    examples: [{ label: "Piazza Unità, Trieste", query: "s=45.6485&w=13.7655&n=45.6520&e=13.7705" }],
  },
  {
    path: "/api/dem",
    summary: "Elevation grid of a bounding box",
    description:
      "Terrain heights sampled on a regular grid. The body is binary and little-endian: a 12-byte header (magic <code>0x4d454433</code>, grid size, source tile zoom as three uint32), then <code>size × size</code> float32 metres above sea level, row by row from the northern edge.",
    returns: "<code>application/octet-stream</code>.",
    groups: [
      {
        title: "Parameters",
        params: [
          ...bbox,
          {
            name: "size",
            type: "integer",
            description: "Samples per side.",
            min: 16,
            max: 513,
            required: true,
          },
        ],
      },
    ],
    examples: [{ label: "A 64 × 64 grid", query: "s=45.6485&w=13.7655&n=45.6520&e=13.7705&size=64" }],
  },
  {
    path: "/api/health",
    summary: "Is the service up",
    description: "A cheap liveness check.",
    returns: "<code>{ ok, version }</code>.",
    groups: [],
    examples: [{ label: "Check", query: "" }],
  },
];

const plain = (html: string) => html.replace(/<[^>]+>/g, "");

/** OpenAPI 3.1 description of the whole API, generated from the same tables as the docs page. */
export function openApiDocument(origin: string): Record<string, unknown> {
  const paths: Record<string, unknown> = {};
  for (const endpoint of ENDPOINTS) {
    const parameters = endpoint.groups.flatMap((group) =>
      group.params.map((param) => {
        const schema: Record<string, unknown> = { type: param.type };
        // List parameters accept several of the values at once, so they are not enums.
        const list = param.name === "layers" || param.name === "hide";
        if (param.values && !list) schema.enum = param.values;
        if (param.min !== undefined) schema.minimum = param.min;
        if (param.max !== undefined) schema.maximum = param.max;
        if (param.default !== undefined) schema.default = param.default;
        return {
          name: param.name,
          in: "query",
          required: param.required ?? false,
          description: plain(param.description),
          schema,
          ...(param.example !== undefined ? { example: param.example } : {}),
        };
      }),
    );
    const binary = { schema: { type: "string", format: "binary" } };
    const content: Record<string, unknown> =
      endpoint.path === "/api/model"
        ? {
            "model/gltf-binary": binary,
            "application/zip": binary,
            "model/stl": binary,
            "model/3mf": binary,
            "application/json": { schema: { $ref: "#/components/schemas/ModelInfo" } },
          }
        : endpoint.path === "/api/dem"
          ? { "application/octet-stream": binary }
          : { "application/json": {} };
    const error = {
      description: "Error",
      content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
    };
    paths[endpoint.path] = {
      get: {
        summary: endpoint.summary,
        description: plain(endpoint.description),
        operationId: endpoint.path.replace("/api/", ""),
        parameters,
        responses: {
          "200": { description: plain(endpoint.returns), content },
          "400": error,
          "404": error,
          "413": error,
          "429": error,
          "502": error,
          "503": error,
        },
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "pop3d API",
      version: config.version,
      description:
        "Turn any place on Earth into a stylised 3D model built from OpenStreetMap and elevation data. Read-only, no authentication, GET only.",
      license: { name: "MIT", identifier: "MIT" },
    },
    servers: [{ url: origin }],
    paths,
    components: {
      schemas: {
        Error: {
          type: "object",
          required: ["error", "code"],
          properties: { error: { type: "string" }, code: { type: "string" } },
        },
        Place: {
          type: "object",
          required: ["id", "name", "detail", "lat", "lon", "kind"],
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            detail: { type: "string" },
            lat: { type: "number" },
            lon: { type: "number" },
            kind: { type: "string" },
            span: { type: "number", description: "Rough size of the feature in metres." },
          },
        },
        ModelInfo: {
          type: "object",
          properties: {
            place: { oneOf: [{ $ref: "#/components/schemas/Place" }, { type: "null" }] },
            center: { type: "object", properties: { lat: { type: "number" }, lon: { type: "number" } } },
            area: { type: "object" },
            options: { type: "object" },
            model: {
              type: "object",
              properties: {
                units: { type: "string" },
                axes: { type: "string" },
                bottom: { type: "number" },
                top: { type: "number" },
                triangles: { type: "integer" },
                layers: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      id: { type: "string" },
                      triangles: { type: "integer" },
                      color: { type: "string" },
                    },
                  },
                },
              },
            },
            stats: { type: "object" },
            formats: { type: "object", additionalProperties: { type: "string" } },
            attribution: { type: "string" },
          },
        },
      },
    },
  };
}

const escapeHtml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function describe(param: Param): string {
  const facts: string[] = [];
  if (param.values) facts.push(param.values.map((value) => `<code>${value}</code>`).join(" "));
  if (param.min !== undefined && param.max !== undefined) facts.push(`${param.min} – ${param.max}`);
  if (param.default !== undefined) facts.push(`default <code>${param.default}</code>`);
  if (param.required) facts.push("<b>required</b>");
  return `<tr><td><code class="name">${param.name}</code><span class="type">${param.type}</span></td><td>${param.description}${
    facts.length ? `<div class="facts">${facts.join(" · ")}</div>` : ""
  }</td></tr>`;
}

/** The human-readable reference served at `/api`. */
export function docsPage(origin: string): string {
  const sections = ENDPOINTS.map((endpoint) => {
    const groups = endpoint.groups
      .map(
        (group) =>
          `${endpoint.groups.length > 1 ? `<h4>${group.title}</h4>` : ""}<table>${group.params.map(describe).join("")}</table>`,
      )
      .join("");
    const examples = endpoint.examples
      .map(({ label, query }) => {
        const href = `${endpoint.path}${query ? `?${query.replace(/ /g, "%20")}` : ""}`;
        return `<li><span>${escapeHtml(label)}</span><a href="${escapeHtml(href)}"><code>${escapeHtml(href)}</code></a></li>`;
      })
      .join("");
    return `<section id="${endpoint.path.replace("/api/", "")}">
      <h2><span class="verb">GET</span> ${endpoint.path}</h2>
      <p class="lead">${endpoint.summary}.</p>
      <p>${endpoint.description}</p>
      ${groups}
      <p class="returns"><b>Returns</b> ${endpoint.returns}</p>
      <ul class="examples">${examples}</ul>
    </section>`;
  }).join("");

  const curl = `curl -o trieste.glb "${origin}/api/model?lat=45.6503&lon=13.7678&size=800"`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>pop3d API</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>
@font-face { font-family: "Geist"; src: url("/fonts/geist-latin-wght-normal.woff2") format("woff2"); font-weight: 100 900; font-display: swap; }
@font-face { font-family: "Geist Mono"; src: url("/fonts/geist-mono-latin-wght-normal.woff2") format("woff2"); font-weight: 100 900; font-display: swap; }
@font-face { font-family: "Fraunces"; src: url("/fonts/fraunces-latin-opsz-normal.woff2") format("woff2"); font-weight: 100 900; font-display: swap; }
:root { --ink: #231f1a; --soft: #5d554b; --faint: #8d8579; --line: rgba(35,31,26,.1); --paper: #f4f0e8; --card: #fffdf9; --accent: #e0552d; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--paper); color: var(--ink); font: 400 15px/1.55 "Geist", system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
main { max-width: 860px; margin: 0 auto; padding: 56px 24px 96px; }
header h1 { font: 500 44px/1.05 "Fraunces", Georgia, serif; letter-spacing: -.02em; margin: 0 0 12px; }
header h1 em { color: var(--accent); font-style: italic; }
header p { font-size: 17px; color: var(--soft); max-width: 62ch; margin: 0 0 20px; }
nav { display: flex; flex-wrap: wrap; gap: 8px; margin: 22px 0 8px; }
nav a, .pill { display: inline-block; padding: 6px 12px; border-radius: 99px; background: rgba(35,31,26,.06); color: var(--ink); text-decoration: none; font-size: 13px; font-weight: 500; }
nav a:hover { background: rgba(35,31,26,.1); }
code { font: 500 13px/1.4 "Geist Mono", ui-monospace, Menlo, monospace; background: rgba(35,31,26,.06); padding: 1.5px 5px; border-radius: 5px; }
pre { margin: 0 0 16px; padding: 14px 16px; border-radius: 12px; background: #26221d; color: #f4efe6; overflow-x: auto; }
pre code { background: none; padding: 0; color: inherit; font-size: 13px; }
section { margin-top: 44px; padding: 26px 28px 22px; background: var(--card); border-radius: 18px; box-shadow: 0 0 0 .5px var(--line), 0 12px 32px -18px rgba(40,30,20,.25); }
h2 { font: 600 19px/1.2 "Geist Mono", monospace; margin: 0 0 6px; letter-spacing: -.01em; }
.verb { font-size: 11px; font-weight: 700; letter-spacing: .06em; color: #fff; background: var(--accent); padding: 3px 7px; border-radius: 6px; vertical-align: 2px; margin-right: 6px; }
.lead { font: 500 20px/1.25 "Fraunces", Georgia, serif; margin: 0 0 10px; }
h4 { margin: 22px 0 6px; font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--faint); }
table { width: 100%; border-collapse: collapse; }
td { padding: 9px 0; border-top: 1px solid var(--line); vertical-align: top; }
td:first-child { width: 168px; padding-right: 16px; white-space: nowrap; }
.name { background: none; padding: 0; font-size: 14px; font-weight: 600; }
.type { display: block; font-size: 11.5px; color: var(--faint); }
.facts { margin-top: 3px; font-size: 13px; color: var(--soft); line-height: 1.9; }
.returns { margin: 18px 0 10px; color: var(--soft); }
.examples { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.examples li { display: grid; gap: 2px; }
.examples span { font-size: 13px; color: var(--soft); }
.examples a { color: var(--accent); text-decoration: none; overflow-wrap: anywhere; }
.examples a code { background: none; padding: 0; color: inherit; }
.examples a:hover { text-decoration: underline; }
.notes { display: grid; gap: 10px; padding-left: 18px; margin: 12px 0 0; color: var(--soft); }
footer { margin-top: 40px; font-size: 13px; color: var(--faint); }
footer a { color: inherit; }
@media (max-width: 620px) { td:first-child { width: 116px; white-space: normal; } section { padding: 20px 18px; } header h1 { font-size: 34px; } }
</style>
</head>
<body>
<main>
<header>
  <h1>pop<em>3d</em> API</h1>
  <p>Any place on Earth as a stylised 3D model, built on demand from OpenStreetMap and elevation data. One request in, one file out: glTF for the screen, STL or 3MF for the printer.</p>
  <pre><code>${escapeHtml(curl)}</code></pre>
  <nav>${ENDPOINTS.map((endpoint) => `<a href="#${endpoint.path.replace("/api/", "")}">${endpoint.path}</a>`).join("")}<a href="/api/openapi.json">OpenAPI</a><a href="/">Open the app</a></nav>
</header>
<section>
  <p class="lead">Good to know.</p>
  <ul class="notes">
    <li>Everything is <code>GET</code>, read-only and needs no key. Cross-origin requests are ${config.cors ? "allowed" : "not allowed"}.</li>
    <li>Models are in metres with Y up: x points east, z south, the origin is the centre of the area and <code>y = 0</code> is its lowest ground. Print files are in millimetres with Z up.</li>
    <li>The first request for a new area waits for the public OpenStreetMap servers, typically 5 to 25 seconds. After that the area and the model are cached and answer at once.</li>
    <li>Areas go from ${MODEL_LIMITS.size[0]} m to ${MODEL_LIMITS.size[1] / 1000} km per side. Requests are rate-limited per address; going over returns <code>429</code>, a full build queue <code>503</code>.</li>
    <li>Errors are JSON, <code>{ "error": "…", "code": "…" }</code>, with a matching HTTP status.</li>
    <li>Map data © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors (ODbL); elevation from Mapzen Terrain Tiles. Models you publish must keep this attribution, which glTF files already carry in their <code>asset.copyright</code>.</li>
  </ul>
</section>
${sections}
<footer>pop3d ${config.version} · <a href="https://github.com/pahorema/pop3d">source on GitHub</a></footer>
</main>
</body>
</html>`;
}
