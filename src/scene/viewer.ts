import { N8AOPass } from "n8ao";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { SMAAPass } from "three/addons/postprocessing/SMAAPass.js";
import type { Diorama } from "./diorama";
import { backdropTexture, contactShadowTexture, TiltShiftShader } from "./effects";
import type { Theme } from "./themes";

export interface ViewSettings {
  shadows: boolean;
  /** Blur radius of shadow edges, in shadow-map texels. */
  shadowSoftness: number;
  ambientOcclusion: boolean;
  /** 0 disables the miniature (tilt-shift) blur, 1 is its full strength. */
  miniature: number;
  /** Compass bearing of the sun in degrees (0 north, 90 east). */
  sunAzimuth: number;
  /** Height of the sun above the horizon in degrees. */
  sunElevation: number;
  autoRotate: boolean;
}

export type ViewPreset = "home" | "top" | "front" | "low";

interface Tween {
  start: number;
  duration: number;
  update(t: number): void;
  done?: () => void;
}

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const easeOut = (t: number) => 1 - (1 - t) ** 3;

/** Owns the WebGL renderer, the camera rig, the lights and the post-processing chain. */
export class Viewer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(28, 1, 1, 10_000);
  readonly controls: OrbitControls;
  /** Called after every rendered frame with the camera heading (radians, 0 = looking north). */
  onFrame: ((heading: number) => void) | null = null;
  /** Called when the user starts orbiting, panning or zooming. */
  onInteract: (() => void) | null = null;

  private composer: EffectComposer;
  private renderPass: RenderPass;
  private aoPass: N8AOPass;
  private tiltH: ShaderPass;
  private tiltV: ShaderPass;
  private sun = new THREE.DirectionalLight();
  private hemisphere = new THREE.HemisphereLight();
  private floor: THREE.Mesh;
  private backdrop: THREE.CanvasTexture | null = null;
  private diorama: Diorama | null = null;
  private theme: Theme | null = null;
  private settings: ViewSettings;
  private tweens = new Set<Tween>();
  private pending = 2;
  private shadowsDirty = true;
  private width = 1;
  private height = 1;
  private pixelRatio = 1;
  private insets = { left: 0, right: 0, top: 0, bottom: 0 };
  private interacting = false;
  private frameTimes: number[] = [];
  private lowResolution = false;
  private raycaster = new THREE.Raycaster();
  private disposed = false;
  private lastFrame = performance.now();

  constructor(
    private readonly container: HTMLElement,
    settings: ViewSettings,
  ) {
    this.settings = { ...settings };
    const renderer = new THREE.WebGLRenderer({
      antialias: false,
      alpha: true,
      powerPreference: "high-performance",
    });
    this.renderer = renderer;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.shadowMap.autoUpdate = false;
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.domElement.classList.add("viewport-canvas");
    container.append(renderer.domElement);

    const pmrem = new THREE.PMREMGenerator(renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();

    this.sun.castShadow = true;
    this.sun.shadow.mapSize.setScalar(Math.min(4096, renderer.capabilities.maxTextureSize));
    this.sun.shadow.bias = -0.0004;
    this.scene.add(this.sun, this.sun.target, this.hemisphere);

    this.floor = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, toneMapped: false }),
    );
    this.floor.renderOrder = -1;
    this.floor.visible = false;
    this.scene.add(this.floor);

    const controls = new OrbitControls(this.camera, renderer.domElement);
    this.controls = controls;
    controls.enableDamping = true;
    controls.dampingFactor = 0.085;
    controls.zoomToCursor = true;
    controls.screenSpacePanning = false;
    controls.rotateSpeed = 0.7;
    controls.zoomSpeed = 1.1;
    controls.maxPolarAngle = THREE.MathUtils.degToRad(86);
    controls.autoRotateSpeed = 0.55;
    controls.addEventListener("start", () => {
      this.interacting = true;
      this.cancelCameraTweens();
      this.onInteract?.();
    });
    controls.addEventListener("end", () => {
      this.interacting = false;
      this.invalidate(40);
    });

    this.composer = new EffectComposer(
      renderer,
      new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType }),
    );
    this.renderPass = new RenderPass(this.scene, this.camera);
    this.aoPass = new N8AOPass(this.scene, this.camera, 1, 1);
    this.aoPass.configuration.gammaCorrection = false;
    this.aoPass.configuration.halfRes = true;
    this.aoPass.configuration.depthAwareUpsampling = true;
    this.aoPass.setQualityMode("Medium");
    // n8ao shims multi-target render targets by making `texture` return the whole array, which
    // current three.js no longer tolerates: restore the standard accessor on its half-res target.
    const halfRes = (this.aoPass as unknown as { depthDownsampleTarget?: THREE.WebGLRenderTarget })
      .depthDownsampleTarget;
    if (halfRes) {
      Object.defineProperty(halfRes, "texture", {
        get(this: THREE.WebGLRenderTarget) {
          return this.textures[0];
        },
      });
    }
    this.tiltH = new ShaderPass(TiltShiftShader);
    this.tiltV = new ShaderPass(TiltShiftShader);
    this.composer.addPass(this.renderPass);
    this.composer.addPass(this.aoPass);
    this.composer.addPass(this.tiltH);
    this.composer.addPass(this.tiltV);
    this.composer.addPass(new OutputPass());
    this.composer.addPass(new SMAAPass());

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.applySettings(settings);
    requestAnimationFrame(this.loop);
  }

  // ---- Frame loop --------------------------------------------------------------------------

  /** Requests redraws for the next `frames` frames; nothing is rendered while idle. */
  invalidate(frames = 2): void {
    if (frames > this.pending) this.pending = frames;
  }

  private loop = (now: number): void => {
    if (this.disposed) return;
    requestAnimationFrame(this.loop);
    const delta = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;

    let animating = false;
    for (const tween of this.tweens) {
      const t = Math.min(1, (now - tween.start) / tween.duration);
      tween.update(t);
      animating = true;
      if (t >= 1) {
        this.tweens.delete(tween);
        tween.done?.();
      }
    }
    const moved = this.controls.update(delta);
    if (!moved && !animating && this.pending <= 0) return;
    if (this.pending > 0) this.pending--;
    // Let damping and accumulated effects settle after the last change.
    if (moved) this.invalidate(12);

    const began = performance.now();
    this.render();
    if (this.interacting || animating) this.trackPerformance(performance.now() - began, delta);
    else if (this.lowResolution && this.pending < 4) this.setLowResolution(false);
  };

  private render(): void {
    const { camera, controls } = this;
    const distance = camera.position.distanceTo(controls.target);
    const radius = this.diorama?.radius ?? 100;
    camera.near = THREE.MathUtils.clamp(distance * 0.012, 0.2, 60);
    camera.far = distance + radius * 8;
    camera.updateProjectionMatrix();

    if (this.shadowsDirty) {
      this.renderer.shadowMap.needsUpdate = true;
      this.shadowsDirty = false;
    }
    // The miniature blur follows the pivot and fades out when looking straight down.
    const polar = controls.getPolarAngle();
    const strength = this.settings.miniature * Math.sin(polar) ** 1.5 * this.height * this.pixelRatio * 0.011;
    const focus = this.focusLine();
    for (const pass of [this.tiltH, this.tiltV]) {
      pass.enabled = strength > 0.3;
      pass.uniforms.uStrength!.value = strength;
      pass.uniforms.uFocus!.value = focus;
    }
    this.composer.render();
    this.onFrame?.(controls.getAzimuthalAngle());
  }

  /** Screen height (0 bottom, 1 top) of the orbit pivot, where the miniature blur stays sharp. */
  private focusLine(): number {
    const point = this.controls.target.clone().project(this.camera);
    return THREE.MathUtils.clamp(point.y * 0.5 + 0.5, 0.25, 0.75);
  }

  /** Drops to a lower resolution while moving if the GPU cannot keep up, and back once at rest. */
  private trackPerformance(renderMs: number, delta: number): void {
    this.frameTimes.push(Math.max(renderMs, delta * 1000));
    if (this.frameTimes.length < 20) return;
    const average = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
    this.frameTimes.length = 0;
    if (average > 30 && !this.lowResolution) this.setLowResolution(true);
  }

  private setLowResolution(low: boolean): void {
    if (this.lowResolution === low) return;
    this.lowResolution = low;
    this.resize();
  }

  private resize(): void {
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    const ratio = Math.min(window.devicePixelRatio || 1, 2) * (this.lowResolution ? 0.6 : 1);
    this.width = width;
    this.height = height;
    this.pixelRatio = ratio;
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(width, height);
    this.composer.setPixelRatio(ratio);
    this.composer.setSize(width, height);
    this.tiltH.uniforms.uDirection!.value.set(1 / (width * ratio), 0);
    this.tiltV.uniforms.uDirection!.value.set(0, 1 / (height * ratio));
    this.camera.aspect = width / height;
    this.applyInsets();
    this.invalidate(3);
  }

  // ---- Camera ------------------------------------------------------------------------------

  /** Space taken by the interface on each side, so the model is centred in what is left. */
  setInsets(insets: Partial<typeof this.insets>, animate = true): void {
    const from = { ...this.insets };
    const to = { ...this.insets, ...insets };
    if (!animate) {
      this.insets = to;
      this.applyInsets();
      this.invalidate();
      return;
    }
    this.tween(420, (t) => {
      const k = easeInOut(t);
      this.insets = {
        left: from.left + (to.left - from.left) * k,
        right: from.right + (to.right - from.right) * k,
        top: from.top + (to.top - from.top) * k,
        bottom: from.bottom + (to.bottom - from.bottom) * k,
      };
      this.applyInsets();
    });
  }

  private applyInsets(): void {
    const { left, right, top, bottom } = this.insets;
    const x = (right - left) / 2;
    const y = (bottom - top) / 2;
    if (Math.abs(x) < 0.5 && Math.abs(y) < 0.5) this.camera.clearViewOffset();
    else this.camera.setViewOffset(this.width, this.height, x, y, this.width, this.height);
    this.camera.updateProjectionMatrix();
  }

  /** Distance at which the whole model fits the free part of the viewport. */
  private fitDistance(): number {
    // Mountains make the model taller than it is wide: frame its whole bulk, not just the plinth.
    const data = this.diorama?.data;
    const radius = Math.hypot(
      this.diorama?.radius ?? 100,
      data ? (data.groundTopY - data.bottomY) * 0.45 : 0,
    );
    const freeWidth = Math.max(200, this.width - this.insets.left - this.insets.right);
    const freeHeight = Math.max(200, this.height - this.insets.top - this.insets.bottom);
    const vertical = THREE.MathUtils.degToRad(this.camera.fov) / 2;
    const tanV = Math.tan(vertical) * (freeHeight / this.height);
    const tanH = Math.tan(vertical) * this.camera.aspect * (freeWidth / this.width);
    // Tall, narrow windows show the model wider than its radius suggests: leave more air.
    const margin = freeWidth < freeHeight ? 1.26 : 1.12;
    return (radius * margin) / Math.sin(Math.atan(Math.min(tanV, tanH)));
  }

  private homeTarget(): THREE.Vector3 {
    // Aim a little below the surface, towards the visual middle of plinth and relief together.
    const data = this.diorama?.data;
    return new THREE.Vector3(0, data ? data.groundTopY * 0.14 + data.bottomY * 0.3 : 0, 0);
  }

  private presetPose(preset: ViewPreset): { target: THREE.Vector3; spherical: THREE.Spherical } {
    const distance = this.fitDistance();
    const deg = THREE.MathUtils.degToRad;
    const poses: Record<ViewPreset, [phi: number, theta: number, zoom: number]> = {
      home: [deg(54), deg(-32), 1],
      top: [deg(0.5), 0, 0.92],
      front: [deg(72), 0, 0.95],
      low: [deg(80), deg(-40), 0.8],
    };
    const [phi, theta, zoom] = poses[preset];
    return { target: this.homeTarget(), spherical: new THREE.Spherical(distance * zoom, phi, theta) };
  }

  /** Smoothly moves the camera to a named viewpoint. */
  flyTo(preset: ViewPreset, duration = 900): void {
    const { target, spherical } = this.presetPose(preset);
    this.flyToPose(target, spherical, duration);
  }

  private flyToPose(target: THREE.Vector3, to: THREE.Spherical, duration: number, done?: () => void): void {
    this.cancelCameraTweens();
    const { camera, controls } = this;
    const fromTarget = controls.target.clone();
    const from = new THREE.Spherical().setFromVector3(camera.position.clone().sub(fromTarget));
    // Turn the short way round.
    let deltaTheta = to.theta - from.theta;
    deltaTheta = ((((deltaTheta + Math.PI) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) - Math.PI;
    const current = new THREE.Spherical();
    const offset = new THREE.Vector3();
    const wasDamping = controls.enableDamping;
    controls.enableDamping = false;
    this.cameraTween = this.tween(
      duration,
      (t) => {
        const k = easeInOut(t);
        controls.target.lerpVectors(fromTarget, target, k);
        current.set(
          from.radius * (to.radius / from.radius) ** k,
          from.phi + (to.phi - from.phi) * k,
          from.theta + deltaTheta * k,
        );
        current.makeSafe();
        camera.position.copy(controls.target).add(offset.setFromSpherical(current));
        camera.lookAt(controls.target);
      },
      () => {
        controls.enableDamping = wasDamping;
        this.cameraTween = null;
        done?.();
      },
    );
  }

  private cameraTween: Tween | null = null;

  private cancelCameraTweens(): void {
    if (!this.cameraTween) return;
    this.tweens.delete(this.cameraTween);
    this.cameraTween = null;
    this.controls.enableDamping = true;
  }

  /** Zooms by a factor around the pivot (values below 1 move closer). */
  zoomBy(factor: number): void {
    const { camera, controls } = this;
    const offset = camera.position.clone().sub(controls.target);
    const spherical = new THREE.Spherical().setFromVector3(offset);
    spherical.radius = THREE.MathUtils.clamp(
      spherical.radius * factor,
      controls.minDistance,
      controls.maxDistance,
    );
    this.flyToPose(controls.target.clone(), spherical, 320);
  }

  /** Turns the view so that north points up, keeping tilt and distance. */
  faceNorth(): void {
    const { camera, controls } = this;
    const spherical = new THREE.Spherical().setFromVector3(camera.position.clone().sub(controls.target));
    spherical.theta = 0;
    this.flyToPose(controls.target.clone(), spherical, 600);
  }

  // ---- Scene content -----------------------------------------------------------------------

  /** Shows a diorama (replacing the previous one) and plays its build-in animation. */
  setDiorama(diorama: Diorama, options: { animate: boolean; keepView: boolean }): void {
    const previous = this.diorama;
    this.diorama = diorama;
    previous?.dispose();
    this.scene.add(diorama.root);

    const { data, radius } = diorama;
    const { area } = data.params;
    const { controls } = this;
    controls.minDistance = radius * 0.08;
    controls.maxDistance = radius * 9;
    controls.maxTargetRadius = radius * 1.05;
    this.aoPass.configuration.aoRadius = THREE.MathUtils.clamp(
      Math.max(area.width, area.depth) * 0.02,
      1.5,
      70,
    );
    this.aoPass.configuration.distanceFalloff = 1;

    const side = Math.max(area.width, area.depth) * 2;
    this.floor.scale.set(side, 1, side);
    this.floor.position.y = data.bottomY - radius * 0.004;
    const material = this.floor.material as THREE.MeshBasicMaterial;
    material.map?.dispose();
    material.map = contactShadowTexture(area.shape, area.width, area.depth);
    material.needsUpdate = true;
    this.floor.visible = true;

    this.placeSun();
    this.shadowsDirty = true;

    const pose = this.presetPose("home");
    if (!options.keepView || !previous) {
      controls.target.copy(pose.target);
      this.camera.position.copy(pose.target).add(new THREE.Vector3().setFromSpherical(pose.spherical));
      this.camera.lookAt(controls.target);
    }
    if (options.animate) {
      diorama.setGrowth(0);
      if (!options.keepView || !previous) {
        // Arrive from a little higher and further while the model rises.
        const from = pose.spherical.clone();
        from.radius *= 1.28;
        from.phi *= 0.72;
        from.theta -= 0.5;
        this.camera.position.copy(pose.target).add(new THREE.Vector3().setFromSpherical(from));
        this.camera.lookAt(controls.target);
        this.flyToPose(pose.target, pose.spherical, 2100);
      }
      this.tween(
        1900,
        (t) => {
          diorama.setGrowth(easeOut(t) * 0.35 + t * 0.65);
          this.shadowsDirty = true;
        },
        () => {
          diorama.setGrowth(1);
          this.shadowsDirty = true;
          this.invalidate(30);
        },
      );
    } else {
      diorama.setGrowth(1);
    }
    this.invalidate(30);
  }

  get current(): Diorama | null {
    return this.diorama;
  }

  /** Call after layers were shown, hidden or restyled. */
  refresh(shadows = true): void {
    if (shadows) this.shadowsDirty = true;
    this.invalidate(20);
  }

  setTheme(theme: Theme): void {
    this.theme = theme;
    this.backdrop = backdropTexture(theme.background[0], theme.background[1], this.backdrop ?? undefined);
    this.scene.background = this.backdrop;
    this.sun.color.set(theme.light.sun);
    this.hemisphere.color.set(theme.light.sky);
    this.hemisphere.groundColor.set(theme.light.bounce);
    this.hemisphere.intensity = theme.light.skyIntensity;
    this.scene.environmentIntensity = theme.light.environment;
    this.renderer.toneMappingExposure = theme.light.exposure;
    this.aoPass.configuration.intensity = theme.ao.intensity;
    this.aoPass.configuration.color.set(theme.ao.color);
    const floor = this.floor.material as THREE.MeshBasicMaterial;
    floor.color.set(theme.shadow.color);
    floor.opacity = theme.shadow.opacity;
    this.placeSun();
    this.refresh();
  }

  applySettings(settings: ViewSettings): void {
    this.settings = { ...settings };
    this.aoPass.enabled = settings.ambientOcclusion;
    this.renderPass.enabled = !settings.ambientOcclusion;
    this.controls.autoRotate = settings.autoRotate;
    this.placeSun();
    this.refresh();
  }

  private placeSun(): void {
    const { settings, sun } = this;
    const radius = this.diorama?.radius ?? 100;
    const top = this.diorama?.data.topY ?? 0;
    const bottom = this.diorama?.data.bottomY ?? 0;
    const azimuth = THREE.MathUtils.degToRad(settings.sunAzimuth);
    const elevation = THREE.MathUtils.degToRad(settings.sunElevation);
    const reach = Math.hypot(radius, top - bottom) * 1.05;
    sun.target.position.set(0, (top + bottom) / 2, 0);
    sun.position
      .set(
        Math.sin(azimuth) * Math.cos(elevation),
        Math.sin(elevation),
        -Math.cos(azimuth) * Math.cos(elevation),
      )
      .multiplyScalar(reach * 3)
      .add(sun.target.position);
    // A low sun is warmer and weaker, like in the real world.
    const strength = THREE.MathUtils.smoothstep(settings.sunElevation, 2, 38);
    sun.intensity = (this.theme?.light.sunIntensity ?? 2.5) * (0.55 + 0.45 * strength);
    sun.castShadow = settings.shadows;
    const shadow = sun.shadow;
    shadow.camera.left = -reach;
    shadow.camera.right = reach;
    shadow.camera.top = reach;
    shadow.camera.bottom = -reach;
    shadow.camera.near = reach;
    shadow.camera.far = reach * 5;
    shadow.camera.updateProjectionMatrix();
    shadow.radius = settings.shadowSoftness;
    shadow.normalBias = ((reach * 2) / shadow.mapSize.x) * 1.4;
    this.shadowsDirty = true;
  }

  // ---- Utilities ---------------------------------------------------------------------------

  private tween(duration: number, update: (t: number) => void, done?: () => void): Tween {
    const tween: Tween = { start: performance.now(), duration, update, done };
    this.tweens.add(tween);
    return tween;
  }

  /** Building under the given viewport point, or -1. */
  pickBuilding(clientX: number, clientY: number): number {
    if (!this.diorama) return -1;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const pointer = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(pointer, this.camera);
    return this.diorama.pick(this.raycaster);
  }

  /** Renders the current view at `scale` times the viewport size and returns it as a PNG. */
  async capture(scale: number, transparent: boolean): Promise<Blob> {
    const { renderer, composer } = this;
    const maxSide = renderer.capabilities.maxTextureSize;
    const factor = Math.min(scale, maxSide / Math.max(this.width, this.height));
    const background = this.scene.background;
    renderer.setPixelRatio(factor);
    renderer.setSize(this.width, this.height, false);
    composer.setPixelRatio(factor);
    composer.setSize(this.width, this.height);
    this.tiltH.uniforms.uDirection!.value.set(1 / (this.width * factor), 0);
    this.tiltV.uniforms.uDirection!.value.set(0, 1 / (this.height * factor));
    const pixelRatio = this.pixelRatio;
    this.pixelRatio = factor;
    try {
      if (transparent) {
        this.scene.background = null;
        this.floor.visible = false;
        renderer.setClearColor(0x000000, 0);
        renderer.render(this.scene, this.camera);
      } else {
        // A few frames let the ambient occlusion denoiser converge.
        for (let i = 0; i < 4; i++) this.render();
      }
      return await new Promise<Blob>((resolve, reject) => {
        renderer.domElement.toBlob(
          (blob) => (blob ? resolve(blob) : reject(new Error("capture failed"))),
          "image/png",
        );
      });
    } finally {
      this.scene.background = background;
      this.floor.visible = this.diorama !== null;
      this.pixelRatio = pixelRatio;
      this.resize();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.diorama?.dispose();
    this.controls.dispose();
    this.renderer.dispose();
  }
}
