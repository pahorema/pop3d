import * as THREE from "three";
import type { ShapeKind } from "../core/types";
import { shapeRing } from "../geo/projection";

/**
 * One direction of a separable blur whose radius grows away from a horizontal focus band:
 * the classic tilt-shift trick that makes a scene read as a miniature.
 */
export const TiltShiftShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uDirection: { value: new THREE.Vector2(1, 0) },
    uFocus: { value: 0.5 },
    uBand: { value: 0.16 },
    uStrength: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 uDirection;
    uniform float uFocus;
    uniform float uBand;
    uniform float uStrength;
    varying vec2 vUv;
    void main() {
      float radius = uStrength * smoothstep(uBand, uBand + 0.38, abs(vUv.y - uFocus));
      if (radius < 0.25) {
        gl_FragColor = texture2D(tDiffuse, vUv);
        return;
      }
      vec4 sum = vec4(0.0);
      float total = 0.0;
      for (int i = -7; i <= 7; i++) {
        float offset = float(i) / 7.0;
        float weight = exp(-3.0 * offset * offset);
        sum += texture2D(tDiffuse, vUv + uDirection * offset * radius) * weight;
        total += weight;
      }
      gl_FragColor = sum / total;
    }`,
};

/** Vertical gradient with a faint vignette, used as the studio backdrop. */
export function backdropTexture(
  top: string,
  bottom: string,
  previous?: THREE.CanvasTexture,
): THREE.CanvasTexture {
  const canvas = (previous?.image as HTMLCanvasElement | undefined) ?? document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 512;
  const context = canvas.getContext("2d")!;
  const gradient = context.createLinearGradient(0, 0, 0, 512);
  gradient.addColorStop(0, top);
  gradient.addColorStop(1, bottom);
  context.fillStyle = gradient;
  context.fillRect(0, 0, 512, 512);
  const glow = context.createRadialGradient(256, 230, 40, 256, 256, 400);
  glow.addColorStop(0, "rgba(255,255,255,0.10)");
  glow.addColorStop(0.55, "rgba(255,255,255,0)");
  glow.addColorStop(1, "rgba(0,0,0,0.10)");
  context.fillStyle = glow;
  context.fillRect(0, 0, 512, 512);
  const texture = previous ?? new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Soft contact shadow in the outline of the plinth, drawn once on a canvas.
 * The texture is white-on-transparent so it can be tinted by the material.
 */
export function contactShadowTexture(shape: ShapeKind, width: number, depth: number): THREE.CanvasTexture {
  const size = 512;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d")!;
  const ring = shapeRing(shape, width, depth);
  const scale = (size * 0.5) / Math.max(width, depth);
  // The shape itself is drawn far off-canvas; only its blurred shadow lands in view.
  const away = size * 2;
  context.shadowColor = "#ffffff";
  context.shadowBlur = size * 0.085;
  context.shadowOffsetX = away;
  context.fillStyle = "#ffffff";
  context.beginPath();
  for (let i = 0; i < ring.length; i += 2) {
    const x = size / 2 + ring[i]! * scale - away;
    const y = size / 2 - ring[i + 1]! * scale;
    if (i === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  }
  context.closePath();
  context.fill();
  context.fill();
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
