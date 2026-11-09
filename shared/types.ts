/** A geocoding result, already normalised across providers. */
export interface Place {
  id: string;
  /** Short title, e.g. "Piazza Unità d'Italia". */
  name: string;
  /** Secondary line, e.g. "34121 Trieste, Friuli-Venezia Giulia, Italia". */
  detail: string;
  lat: number;
  lon: number;
  /** Coarse feature class from the provider: "city", "street", "house", "postcode", "peak"... */
  kind: string;
  /** Rough size of the feature in metres, when the provider knows its extent. */
  span?: number;
}

/**
 * Compact OpenStreetMap extract served by `/api/osm`.
 *
 * Coordinates are integers in 1e-7 degree units relative to `origin`, flattened as
 * `[lat, lon, lat, lon, ...]`. It parses several times faster than raw Overpass JSON
 * and keeps only the tags the renderer understands.
 */
export interface OsmPayload {
  v: 1;
  /** Timestamp of the OSM snapshot the extract was taken from. */
  timestamp: string;
  origin: { lat: number; lon: number };
  nodes: OsmNode[];
  ways: OsmWay[];
  relations: OsmRelation[];
}

export type OsmTags = Record<string, string>;

export interface OsmNode {
  id: number;
  tags: OsmTags;
  /** `[lat, lon]` in payload units. */
  p: [number, number];
}

export interface OsmWay {
  id: number;
  tags: OsmTags;
  g: number[];
}

export interface OsmRelation {
  id: number;
  tags: OsmTags;
  members: { role: string; g: number[] }[];
}

export const OSM_COORD_SCALE = 1e7;

/** Binary header of `/api/dem`: magic, grid size, tile zoom the samples came from. */
export const DEM_MAGIC = 0x4d454433; // "3DEM" little endian
export const DEM_HEADER_BYTES = 12;
