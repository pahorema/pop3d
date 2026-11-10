import type { Ring } from "./poly";
import type { Grid } from "./tessellate";

/**
 * Terrain as a regular grid of elevations over the diorama's bounding box.
 *
 * The surface is piecewise linear: every cell is split into two triangles along the diagonal
 * that follows the terrain best. `heightAt` evaluates exactly that surface, and the tessellator
 * splits full cells along the same diagonals, so every layer draped on the terrain is parallel
 * to it instead of poking through.
 */
export class Heightfield implements Grid {
  /** Cells per side. */
  readonly n: number;
  readonly xs: Float64Array;
  readonly ys: Float64Array;
  readonly cellX: number;
  readonly cellY: number;
  /** Elevations in scene units; row 0 is the northern edge, column 0 the western one. */
  readonly heights: Float32Array;
  private diagonals!: Uint8Array;
  private slopeX!: Float32Array;
  private slopeY!: Float32Array;

  constructor(
    n: number,
    readonly minX: number,
    readonly minY: number,
    readonly maxX: number,
    readonly maxY: number,
    heights?: Float32Array,
  ) {
    this.n = n;
    this.heights = heights ?? new Float32Array((n + 1) * (n + 1));
    this.cellX = (maxX - minX) / n;
    this.cellY = (maxY - minY) / n;
    this.xs = new Float64Array(n + 1);
    this.ys = new Float64Array(n + 1);
    for (let i = 0; i <= n; i++) {
      this.xs[i] = i === n ? maxX : minX + i * this.cellX;
      this.ys[i] = i === n ? maxY : minY + i * this.cellY;
    }
    this.refresh();
  }

  /** Recomputes the derived data after `heights` changed. */
  refresh(): void {
    const { n, heights } = this;
    const w = n + 1;
    this.diagonals = new Uint8Array(n * n);
    for (let row = 0; row < n; row++) {
      for (let col = 0; col < n; col++) {
        const nw = heights[row * w + col]!;
        const ne = heights[row * w + col + 1]!;
        const sw = heights[(row + 1) * w + col]!;
        const se = heights[(row + 1) * w + col + 1]!;
        // 1 = split along the north-west / south-east diagonal, 0 = south-west / north-east.
        this.diagonals[row * n + col] = Math.abs(nw - se) <= Math.abs(ne - sw) ? 1 : 0;
      }
    }
    this.slopeX = new Float32Array(w * w);
    this.slopeY = new Float32Array(w * w);
    for (let row = 0; row <= n; row++) {
      for (let col = 0; col <= n; col++) {
        const west = heights[row * w + Math.max(0, col - 1)]!;
        const east = heights[row * w + Math.min(n, col + 1)]!;
        const north = heights[Math.max(0, row - 1) * w + col]!;
        const south = heights[Math.min(n, row + 1) * w + col]!;
        const spanX = (Math.min(n, col + 1) - Math.max(0, col - 1)) * this.cellX;
        const spanY = (Math.min(n, row + 1) - Math.max(0, row - 1)) * this.cellY;
        this.slopeX[row * w + col] = (east - west) / spanX;
        this.slopeY[row * w + col] = (north - south) / spanY;
      }
    }
  }

  /** Grid interface: `iy` counts rows from the south. */
  diagonal(ix: number, iy: number): number {
    return this.diagonals[(this.n - 1 - iy) * this.n + ix]!;
  }

  /** Elevation of the terrain surface at a point in local map coordinates (x east, y north). */
  heightAt(x: number, y: number): number {
    const { n, heights } = this;
    let fx = (x - this.minX) / this.cellX;
    let fy = (this.maxY - y) / this.cellY;
    fx = fx < 0 ? 0 : fx > n ? n : fx;
    fy = fy < 0 ? 0 : fy > n ? n : fy;
    const col = fx >= n ? n - 1 : Math.floor(fx);
    const row = fy >= n ? n - 1 : Math.floor(fy);
    const u = fx - col;
    const v = fy - row;
    const i = row * (n + 1) + col;
    const nw = heights[i]!;
    const ne = heights[i + 1]!;
    const sw = heights[i + n + 1]!;
    const se = heights[i + n + 2]!;
    if (this.diagonals[row * n + col] === 1) {
      return u >= v ? nw + u * (ne - nw) + v * (se - ne) : nw + u * (se - sw) + v * (sw - nw);
    }
    return u + v <= 1 ? nw + u * (ne - nw) + v * (sw - nw) : se + (1 - u) * (sw - se) + (1 - v) * (ne - se);
  }

  /** Smooth surface normal, written as scene coordinates (x east, y up, z south). */
  normalAt(x: number, y: number, out: Float32Array, offset: number): void {
    const { n } = this;
    let fx = (x - this.minX) / this.cellX;
    let fy = (this.maxY - y) / this.cellY;
    fx = fx < 0 ? 0 : fx > n ? n : fx;
    fy = fy < 0 ? 0 : fy > n ? n : fy;
    const col = fx >= n ? n - 1 : Math.floor(fx);
    const row = fy >= n ? n - 1 : Math.floor(fy);
    const u = fx - col;
    const v = fy - row;
    const i = row * (n + 1) + col;
    const blend = (a: Float32Array) =>
      (a[i]! * (1 - u) + a[i + 1]! * u) * (1 - v) + (a[i + n + 1]! * (1 - u) + a[i + n + 2]! * u) * v;
    const sx = blend(this.slopeX);
    const sy = blend(this.slopeY);
    const length = Math.hypot(sx, 1, sy);
    out[offset] = -sx / length;
    out[offset + 1] = 1 / length;
    out[offset + 2] = sy / length;
  }

  /** Lowest and highest terrain elevation under a ring's vertices and centre. */
  rangeUnder(ring: ArrayLike<number>): [number, number] {
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < ring.length; i += 2) {
      const h = this.heightAt(ring[i]!, ring[i + 1]!);
      if (h < min) min = h;
      if (h > max) max = h;
    }
    return [min, max];
  }

  /** Separable Gaussian blur, `sigma` in samples. */
  smooth(sigma: number): void {
    if (sigma < 0.3) return;
    const radius = Math.max(1, Math.ceil(sigma * 2.5));
    const kernel = new Float32Array(radius * 2 + 1);
    let total = 0;
    for (let i = -radius; i <= radius; i++) {
      const weight = Math.exp(-(i * i) / (2 * sigma * sigma));
      kernel[i + radius] = weight;
      total += weight;
    }
    for (let i = 0; i < kernel.length; i++) kernel[i]! /= total;
    const w = this.n + 1;
    const source = this.heights;
    const temp = new Float32Array(source.length);
    for (let row = 0; row < w; row++) {
      for (let col = 0; col < w; col++) {
        let sum = 0;
        for (let k = -radius; k <= radius; k++) {
          const c = Math.min(w - 1, Math.max(0, col + k));
          sum += source[row * w + c]! * kernel[k + radius]!;
        }
        temp[row * w + col] = sum;
      }
    }
    for (let row = 0; row < w; row++) {
      for (let col = 0; col < w; col++) {
        let sum = 0;
        for (let k = -radius; k <= radius; k++) {
          const r = Math.min(w - 1, Math.max(0, row + k));
          sum += temp[r * w + col]! * kernel[k + radius]!;
        }
        source[row * w + col] = sum;
      }
    }
  }

  /**
   * Indices of the samples covered by the rings (even-odd), widened by one sample on each side
   * so that the banks are included. Only the rows the rings span are visited.
   */
  samplesUnder(rings: Ring[]): number[] {
    const w = this.n + 1;
    let low = Number.POSITIVE_INFINITY;
    let high = Number.NEGATIVE_INFINITY;
    for (const ring of rings) {
      for (let i = 1; i < ring.length; i += 2) {
        if (ring[i]! < low) low = ring[i]!;
        if (ring[i]! > high) high = ring[i]!;
      }
    }
    const out: number[] = [];
    if (low > high) return out;
    const firstRow = Math.max(0, Math.floor((this.maxY - high) / this.cellY) - 1);
    const lastRow = Math.min(w - 1, Math.ceil((this.maxY - low) / this.cellY) + 1);
    const crossings: number[] = [];
    for (let row = firstRow; row <= lastRow; row++) {
      // Nudge the scanline towards the shape so thin water still catches its nearest row.
      const y = Math.min(high, Math.max(low, this.maxY - row * this.cellY));
      crossings.length = 0;
      for (const ring of rings) {
        const len = ring.length;
        for (let i = 0, j = len - 2; i < len; j = i, i += 2) {
          const yi = ring[i + 1]!;
          const yj = ring[j + 1]!;
          if (yi > y !== yj > y) {
            crossings.push(ring[i]! + ((y - yi) / (yj - yi)) * (ring[j]! - ring[i]!));
          }
        }
      }
      if (crossings.length < 2) continue;
      crossings.sort((a, b) => a - b);
      for (let k = 0; k + 1 < crossings.length; k += 2) {
        const from = Math.max(0, Math.floor((crossings[k]! - this.minX) / this.cellX));
        const to = Math.min(w - 1, Math.ceil((crossings[k + 1]! - this.minX) / this.cellX));
        for (let col = from; col <= to; col++) out.push(row * w + col);
      }
    }
    return out;
  }

  /**
   * Marks the samples covered by the rings (even-odd), optionally growing the mask by
   * `grow` samples so that shorelines are covered too.
   */
  rasterize(rings: Ring[], grow = 0): Uint8Array {
    const w = this.n + 1;
    const mask = new Uint8Array(w * w);
    const crossings: number[] = [];
    for (let row = 0; row < w; row++) {
      const y = this.maxY - row * this.cellY;
      crossings.length = 0;
      for (const ring of rings) {
        const len = ring.length;
        for (let i = 0, j = len - 2; i < len; j = i, i += 2) {
          const yi = ring[i + 1]!;
          const yj = ring[j + 1]!;
          if (yi > y !== yj > y) {
            crossings.push(ring[i]! + ((y - yi) / (yj - yi)) * (ring[j]! - ring[i]!));
          }
        }
      }
      if (crossings.length < 2) continue;
      crossings.sort((a, b) => a - b);
      for (let k = 0; k + 1 < crossings.length; k += 2) {
        const from = Math.max(0, Math.ceil((crossings[k]! - this.minX) / this.cellX));
        const to = Math.min(w - 1, Math.floor((crossings[k + 1]! - this.minX) / this.cellX));
        for (let col = from; col <= to; col++) mask[row * w + col] = 1;
      }
    }
    for (let pass = 0; pass < grow; pass++) {
      const previous = mask.slice();
      for (let row = 0; row < w; row++) {
        for (let col = 0; col < w; col++) {
          if (previous[row * w + col]) continue;
          if (
            (col > 0 && previous[row * w + col - 1]) ||
            (col < w - 1 && previous[row * w + col + 1]) ||
            (row > 0 && previous[(row - 1) * w + col]) ||
            (row < w - 1 && previous[(row + 1) * w + col])
          ) {
            mask[row * w + col] = 1;
          }
        }
      }
    }
    return mask;
  }
}
