import type { MeshData } from "../core/types";
import type { Heightfield } from "./heightfield";
import type { Tessellation } from "./tessellate";

/** Growable indexed triangle mesh in scene coordinates (x east, y up, z south). */
export class MeshBuilder {
  positions: number[] = [];
  normals: number[] = [];
  indices: number[] = [];

  get vertexCount(): number {
    return this.positions.length / 3;
  }

  get triangleCount(): number {
    return this.indices.length / 3;
  }

  vertex(x: number, y: number, z: number, nx: number, ny: number, nz: number): number {
    const index = this.positions.length / 3;
    this.positions.push(x, y, z);
    this.normals.push(nx, ny, nz);
    return index;
  }

  /** Flat quad from four corners given counter-clockwise as seen from the front. */
  quad(
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    cx: number,
    cy: number,
    cz: number,
    dx: number,
    dy: number,
    dz: number,
    nx: number,
    ny: number,
    nz: number,
  ): void {
    const i = this.positions.length / 3;
    this.positions.push(ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz);
    this.normals.push(nx, ny, nz, nx, ny, nz, nx, ny, nz, nx, ny, nz);
    this.indices.push(i, i + 1, i + 2, i, i + 2, i + 3);
  }

  finish(): MeshData {
    return {
      positions: new Float32Array(this.positions),
      normals: new Float32Array(this.normals),
      indices: new Uint32Array(this.indices),
    };
  }
}

export type HeightFn = (x: number, y: number) => number;

/** Lays a tessellated surface over the terrain, `offset` above it. */
export function addSurface(
  mesh: MeshBuilder,
  tess: Tessellation,
  terrain: Heightfield,
  offset: number,
  flip = false,
): void {
  const base = mesh.vertexCount;
  const { xy, triangles } = tess;
  const normal = new Float32Array(3);
  for (let i = 0; i < xy.length; i += 2) {
    const x = xy[i]!;
    const y = xy[i + 1]!;
    terrain.normalAt(x, y, normal, 0);
    mesh.positions.push(x, terrain.heightAt(x, y) + offset, -y);
    if (flip) mesh.normals.push(-normal[0]!, -normal[1]!, -normal[2]!);
    else mesh.normals.push(normal[0]!, normal[1]!, normal[2]!);
  }
  for (let i = 0; i < triangles.length; i += 3) {
    if (flip) mesh.indices.push(base + triangles[i]!, base + triangles[i + 2]!, base + triangles[i + 1]!);
    else mesh.indices.push(base + triangles[i]!, base + triangles[i + 1]!, base + triangles[i + 2]!);
  }
}

/** Same surface at a constant elevation (used for undersides). */
export function addFlatSurface(mesh: MeshBuilder, tess: Tessellation, y: number, facingUp: boolean): void {
  const base = mesh.vertexCount;
  const { xy, triangles } = tess;
  for (let i = 0; i < xy.length; i += 2) {
    mesh.positions.push(xy[i]!, y, -xy[i + 1]!);
    mesh.normals.push(0, facingUp ? 1 : -1, 0);
  }
  for (let i = 0; i < triangles.length; i += 3) {
    if (facingUp) mesh.indices.push(base + triangles[i]!, base + triangles[i + 1]!, base + triangles[i + 2]!);
    else mesh.indices.push(base + triangles[i]!, base + triangles[i + 2]!, base + triangles[i + 1]!);
  }
}

/**
 * Vertical wall along one outline segment (surface on the left of a -> b), facing outwards.
 * `top` and `bottom` give the elevation at each end.
 */
export function addWall(
  mesh: MeshBuilder,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  topA: number,
  topB: number,
  bottomA: number,
  bottomB: number,
): void {
  if (topA - bottomA < 1e-4 && topB - bottomB < 1e-4) return;
  const dx = bx - ax;
  const dy = by - ay;
  const length = Math.hypot(dx, dy);
  if (length < 1e-6) return;
  const nx = dy / length;
  const nz = dx / length;
  mesh.quad(ax, topA, -ay, ax, bottomA, -ay, bx, bottomB, -by, bx, topB, -by, nx, 0, nz);
}

/** Walls under every outline segment accepted by `filter`. */
export function addWalls(
  mesh: MeshBuilder,
  edges: number[],
  top: HeightFn,
  bottom: HeightFn,
  filter?: (ax: number, ay: number, bx: number, by: number) => boolean,
): void {
  for (let i = 0; i < edges.length; i += 4) {
    const ax = edges[i]!;
    const ay = edges[i + 1]!;
    const bx = edges[i + 2]!;
    const by = edges[i + 3]!;
    if (filter && !filter(ax, ay, bx, by)) continue;
    addWall(mesh, ax, ay, bx, by, top(ax, ay), top(bx, by), bottom(ax, ay), bottom(bx, by));
  }
}
