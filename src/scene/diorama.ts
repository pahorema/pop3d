import * as THREE from "three";
import { type DioramaData, LAYERS, type LayerId, type MeshData, TREE_STRIDE } from "../core/types";
import type { Theme } from "./themes";

export type BuildingColorMode = "theme" | "height" | "kind";

export interface DioramaStyle {
  theme: Theme;
  buildingColors: BuildingColorMode;
  edges: boolean;
  /** Faceted, low-poly shading for terrain and layers. */
  faceted: boolean;
}

/** Shared uniforms driving the build-in animation in every patched material. */
interface GrowUniforms {
  uGrow: { value: number };
  uSpread: { value: number };
}

const KIND_GROUPS: [RegExp, string][] = [
  [
    /^(house|detached|semidetached_house|terrace|bungalow|residential|apartments|dormitory|cabin|farm)$/,
    "#f2c078",
  ],
  [/^(commercial|retail|office|supermarket|hotel|kiosk)$/, "#7fb7e6"],
  [/^(industrial|warehouse|hangar|barn|farm_auxiliary|stable|greenhouse)$/, "#b9a3d6"],
  [/^(church|chapel|cathedral|mosque|temple|synagogue|monastery)$/, "#f08d8d"],
  [/^(school|university|college|kindergarten|hospital|civic|public|government)$/, "#7fd1b3"],
  [/^(train_station|transportation|parking|garage|garages|carport)$/, "#a9b4c2"],
  [/^(castle|tower|city_wall|ruins)$/, "#d9a273"],
];

function hash(index: number, salt: number): number {
  let h = Math.imul(index + 1, 0x9e3779b1) ^ Math.imul(salt + 1, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

function geometryOf(mesh: MeshData): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(mesh.positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(mesh.normals, 3));
  geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();
  return geometry;
}

/**
 * Makes a material grow its geometry out of the ground: each vertex is pulled back towards
 * its `aBase` elevation until the wave of the animation (`uGrow`, delayed by `aDelay`) reaches it.
 * The same patch is applied to the depth material so that shadows follow.
 */
function patchGrow<T extends THREE.Material>(material: T, uniforms: GrowUniforms, instanced: boolean): T {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uGrow = uniforms.uGrow;
    shader.uniforms.uSpread = uniforms.uSpread;
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
        uniform float uGrow;
        uniform float uSpread;
        attribute float aDelay;
        ${instanced ? "" : "attribute float aBase;"}
        float growAmount() {
          float t = clamp(uGrow * (1.0 + uSpread) - aDelay * uSpread, 0.0, 1.0);
          float s = 1.0 - t;
          return 1.0 - s * s * s + sin(t * 3.14159265) * 0.07 * s;
        }`,
      )
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        float grow = growAmount();
        ${instanced ? "transformed *= grow;" : "transformed.y = mix(aBase, transformed.y, grow);"}`,
      );
  };
  material.customProgramCacheKey = () => (instanced ? "grow-instanced" : "grow");
  return material;
}

/** The three.js incarnation of a built diorama: one object per layer, restylable in place. */
export class Diorama {
  readonly root = new THREE.Group();
  readonly objects = new Map<LayerId, THREE.Object3D>();
  readonly radius: number;
  private materials = new Map<LayerId, THREE.MeshStandardMaterial>();
  private grow: GrowUniforms = { uGrow: { value: 1 }, uSpread: { value: 2.2 } };
  private buildingMesh: THREE.Mesh | null = null;
  private buildingColors: Float32Array | null = null;
  private edgeLines: THREE.LineSegments | null = null;
  private trunks: THREE.InstancedMesh | null = null;
  private crowns: THREE.InstancedMesh | null = null;
  private conifers: THREE.InstancedMesh | null = null;
  private hidden = new Set<number>();
  private selected = -1;
  private dimmed: LayerId | null = null;
  private style: DioramaStyle;

  constructor(
    readonly data: DioramaData,
    style: DioramaStyle,
  ) {
    this.style = style;
    const { area } = data.params;
    // Radius of the circle enclosing the footprint: corners only count for boxy outlines.
    const half = Math.max(area.width, area.depth) / 2;
    const corner = Math.hypot(area.width, area.depth) / 2;
    this.radius =
      area.shape === "square" ? corner : area.shape === "rounded" ? half + (corner - half) * 0.55 : half;

    for (const layer of LAYERS) {
      const mesh = data.layers[layer];
      if (!mesh || !mesh.indices.length) continue;
      const material = new THREE.MeshStandardMaterial({ metalness: 0 });
      this.materials.set(layer, material);
      const object = new THREE.Mesh(geometryOf(mesh), material);
      object.name = layer;
      object.castShadow = layer !== "water";
      object.receiveShadow = true;
      this.objects.set(layer, object);
      this.root.add(object);
    }
    this.createBuildings();
    this.createTrees();
    this.applyStyle(style);
  }

  // ---- Construction ------------------------------------------------------------------------

  private delayOf(x: number, z: number): number {
    return Math.min(1, Math.hypot(x, z) / this.radius);
  }

  private createBuildings(): void {
    const { buildings } = this.data;
    if (!buildings.indices.length) return;
    const geometry = geometryOf(buildings);
    const count = buildings.positions.length / 3;
    const delay = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const b = buildings.owner[i]! * 4;
      delay[i] = this.delayOf(buildings.anchors[b]!, buildings.anchors[b + 2]!);
    }
    this.buildingColors = new Float32Array(count * 3);
    geometry.setAttribute("color", new THREE.BufferAttribute(this.buildingColors, 3));
    geometry.setAttribute("aBase", new THREE.BufferAttribute(buildings.base, 1));
    geometry.setAttribute("aDelay", new THREE.BufferAttribute(delay, 1));

    const material = patchGrow(
      new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0 }),
      this.grow,
      false,
    );
    this.materials.set("buildings", material);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = "buildings";
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.customDepthMaterial = patchGrow(
      new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking }),
      this.grow,
      false,
    );
    this.buildingMesh = mesh;
    this.objects.set("buildings", mesh);
    this.root.add(mesh);

    if (buildings.edges.length) {
      const lines = new THREE.BufferGeometry();
      lines.setAttribute("position", new THREE.BufferAttribute(buildings.edges, 3));
      this.edgeLines = new THREE.LineSegments(
        lines,
        new THREE.LineBasicMaterial({ transparent: true, depthWrite: false }),
      );
      this.edgeLines.name = "edges";
      this.edgeLines.visible = false;
      mesh.add(this.edgeLines);
    }
  }

  private createTrees(): void {
    const { trees } = this.data;
    if (!trees.count) return;
    const group = new THREE.Group();
    group.name = "trees";

    const trunkGeometry = new THREE.CylinderGeometry(0.6, 1, 1, 5, 1, false).translate(0, 0.5, 0);
    const crownGeometry = new THREE.IcosahedronGeometry(1, 1);
    const coniferGeometry = new THREE.ConeGeometry(1, 1, 7, 1, false).translate(0, 0.5, 0);
    let broadleaved = 0;
    for (let i = 0; i < trees.count; i++) if (!trees.kinds[i]) broadleaved++;

    const make = (
      geometry: THREE.BufferGeometry,
      count: number,
      flat: boolean,
    ): THREE.InstancedMesh | null => {
      if (!count) return null;
      const material = patchGrow(
        new THREE.MeshStandardMaterial({ metalness: 0, roughness: 0.95, flatShading: flat }),
        this.grow,
        true,
      );
      const mesh = new THREE.InstancedMesh(geometry, material, count);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.customDepthMaterial = patchGrow(
        new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking }),
        this.grow,
        true,
      );
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
      geometry.setAttribute("aDelay", new THREE.InstancedBufferAttribute(new Float32Array(count), 1));
      group.add(mesh);
      return mesh;
    };

    this.trunks = make(trunkGeometry, trees.count, false);
    this.crowns = make(crownGeometry, broadleaved, true);
    this.conifers = make(coniferGeometry, trees.count - broadleaved, true);

    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const scale = new THREE.Vector3();
    const rotation = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    let crownIndex = 0;
    let coniferIndex = 0;
    for (let i = 0; i < trees.count; i++) {
      const o = i * TREE_STRIDE;
      const x = trees.data[o]!;
      const y = trees.data[o + 1]!;
      const z = trees.data[o + 2]!;
      const height = trees.data[o + 3]!;
      const radius = trees.data[o + 4]!;
      const seed = trees.data[o + 5]!;
      const delay = this.delayOf(x, z);
      rotation.setFromAxisAngle(up, seed * Math.PI * 2);
      const conifer = trees.kinds[i] === 1;

      const trunkHeight = conifer ? height * 0.22 : height - radius * 1.5;
      position.set(x, y, z);
      scale.set(radius * 0.2, Math.max(0.5, trunkHeight), radius * 0.2);
      this.trunks!.setMatrixAt(i, matrix.compose(position, rotation, scale));
      (this.trunks!.geometry.getAttribute("aDelay") as THREE.BufferAttribute).setX(i, delay);

      if (conifer) {
        position.set(x, y + height * 0.16, z);
        scale.set(radius, height * 0.84, radius);
        this.conifers!.setMatrixAt(coniferIndex, matrix.compose(position, rotation, scale));
        (this.conifers!.geometry.getAttribute("aDelay") as THREE.BufferAttribute).setX(coniferIndex, delay);
        coniferIndex++;
      } else {
        position.set(x, y + height - radius * 0.95, z);
        scale.set(radius, radius * (0.9 + seed * 0.25), radius);
        this.crowns!.setMatrixAt(crownIndex, matrix.compose(position, rotation, scale));
        (this.crowns!.geometry.getAttribute("aDelay") as THREE.BufferAttribute).setX(crownIndex, delay);
        crownIndex++;
      }
    }
    for (const mesh of [this.trunks, this.crowns, this.conifers]) {
      if (!mesh) continue;
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      mesh.computeBoundingBox();
    }
    this.objects.set("trees", group);
    this.root.add(group);
  }

  // ---- Styling -----------------------------------------------------------------------------

  applyStyle(style: DioramaStyle): void {
    this.style = style;
    const { theme } = style;
    for (const [layer, material] of this.materials) {
      if (layer === "buildings") {
        material.roughness = theme.surface.roughness;
      } else if (layer !== "trees") {
        material.color.set(theme.layers[layer]);
        material.roughness = layer === "water" ? theme.surface.waterRoughness : theme.surface.roughness;
        material.metalness = layer === "water" ? theme.surface.waterMetalness : 0;
        const faceted = style.faceted && layer !== "water" && layer !== "base";
        if (material.flatShading !== faceted) {
          material.flatShading = faceted;
          material.needsUpdate = true;
        }
      }
    }
    this.paintBuildings();
    this.paintTrees();
    if (this.edgeLines) {
      const material = this.edgeLines.material as THREE.LineBasicMaterial;
      const edges = theme.edges ?? {
        color: theme.dark ? "#ffffff" : "#3b3530",
        opacity: theme.dark ? 0.5 : 0.35,
      };
      material.color.set(edges.color);
      material.opacity = edges.opacity;
      this.edgeLines.visible = style.edges || theme.edges !== null;
    }
    this.applyDim();
  }

  private paintBuildings(): void {
    const colors = this.buildingColors;
    if (!colors || !this.buildingMesh) return;
    const { buildings } = this.data;
    const { theme, buildingColors: mode } = this.style;
    const walls = theme.walls.map((c) => new THREE.Color(c));
    const roofs = theme.roofs.map((c) => new THREE.Color(c));
    const accent = new THREE.Color(theme.dark ? "#ffd166" : "#ff7a45");
    const low = new THREE.Color(theme.dark ? "#3b4a7a" : "#fff3d6");
    const high = new THREE.Color(theme.dark ? "#ffcf6e" : "#e4572e");
    const kinds = KIND_GROUPS.map(([pattern, color]) => [pattern, new THREE.Color(color)] as const);
    const neutral = new THREE.Color(theme.dark ? "#55607f" : "#ebe6dc");
    const wall = new THREE.Color();
    const roof = new THREE.Color();

    let tallest = 1;
    for (const item of buildings.info) tallest = Math.max(tallest, item.height);

    for (let b = 0; b < buildings.info.length; b++) {
      const item = buildings.info[b]!;
      if (b === this.selected) {
        wall.copy(accent);
        roof.copy(accent).offsetHSL(0, 0, 0.06);
      } else if (mode === "height") {
        const t = Math.sqrt(Math.min(1, item.height / Math.min(tallest, 120)));
        wall.copy(low).lerp(high, t);
        roof.copy(wall).offsetHSL(0, 0, 0.05);
      } else if (mode === "kind") {
        const match = kinds.find(([pattern]) => pattern.test(item.kind));
        wall.copy(match ? match[1] : neutral);
        roof.copy(wall).offsetHSL(0, -0.05, -0.07);
      } else {
        const pick = hash(b, 1);
        wall.copy(walls[Math.floor(pick * walls.length)]!);
        roof.copy(roofs[Math.floor(hash(b, 2) * roofs.length)]!);
        const shade = (hash(b, 3) - 0.5) * 0.035;
        wall.offsetHSL(0, 0, shade);
        roof.offsetHSL(0, 0, shade);
      }
      const first = buildings.ranges[b * 4]!;
      const count = buildings.ranges[b * 4 + 1]!;
      for (let v = first; v < first + count; v++) {
        const c = buildings.part[v] === 1 ? roof : wall;
        colors[v * 3] = c.r;
        colors[v * 3 + 1] = c.g;
        colors[v * 3 + 2] = c.b;
      }
    }
    (this.buildingMesh.geometry.getAttribute("color") as THREE.BufferAttribute).needsUpdate = true;
  }

  private paintTrees(): void {
    const { trees } = this.data;
    if (!trees.count) return;
    const { theme } = this.style;
    const crowns = theme.trees.crowns.map((c) => new THREE.Color(c));
    const conifer = new THREE.Color(theme.trees.conifer);
    const trunk = new THREE.Color(theme.trees.trunk);
    const color = new THREE.Color();
    let crownIndex = 0;
    let coniferIndex = 0;
    for (let i = 0; i < trees.count; i++) {
      const seed = trees.data[i * TREE_STRIDE + 5]!;
      this.trunks!.setColorAt(i, trunk);
      const shade = (hash(i, 7) - 0.5) * 0.06;
      if (trees.kinds[i] === 1) {
        color.copy(conifer).offsetHSL(0, 0, shade);
        this.conifers!.setColorAt(coniferIndex++, color);
      } else {
        color.copy(crowns[Math.floor(seed * crowns.length) % crowns.length]!).offsetHSL(0, 0, shade);
        this.crowns!.setColorAt(crownIndex++, color);
      }
    }
    for (const mesh of [this.trunks, this.crowns, this.conifers]) {
      if (mesh?.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }

  // ---- Visibility, emphasis, selection -----------------------------------------------------

  setVisibility(visible: Record<LayerId, boolean>, solo: LayerId | null): void {
    for (const [layer, object] of this.objects) {
      object.visible = solo ? layer === solo || layer === "base" : visible[layer] !== false;
    }
  }

  /** Fades every layer but one, to point it out. Pass `null` to restore. */
  emphasize(layer: LayerId | null): void {
    if (this.dimmed === layer) return;
    this.dimmed = layer;
    this.applyStyle(this.style);
  }

  private applyDim(): void {
    const focus = this.dimmed;
    const { theme } = this.style;
    const mute = new THREE.Color(theme.background[1]).lerp(new THREE.Color(theme.layers.ground), 0.5);
    for (const [layer, material] of this.materials) {
      const dim = focus !== null && layer !== focus;
      if (layer === "buildings") {
        material.color.set(dim ? mute : "#ffffff");
        material.vertexColors = !dim;
        material.needsUpdate = true;
      } else if (dim) {
        material.color.lerp(mute, 0.82);
      }
    }
    for (const mesh of [this.trunks, this.crowns, this.conifers]) {
      if (!mesh) continue;
      const material = mesh.material as THREE.MeshStandardMaterial;
      material.color.set(focus !== null && focus !== "trees" ? mute : "#ffffff");
    }
  }

  select(building: number): void {
    if (this.selected === building) return;
    this.selected = building;
    this.paintBuildings();
  }

  get selection(): number {
    return this.selected;
  }

  /** Hides or shows single buildings by rebuilding the index buffer without them. */
  setBuildingHidden(building: number, hide: boolean): void {
    if (hide) this.hidden.add(building);
    else this.hidden.delete(building);
    this.rebuildIndex();
  }

  showAllBuildings(): void {
    this.hidden.clear();
    this.rebuildIndex();
  }

  get hiddenBuildings(): number {
    return this.hidden.size;
  }

  private rebuildIndex(): void {
    if (!this.buildingMesh) return;
    const { buildings } = this.data;
    const source = buildings.indices;
    let index = source;
    if (this.hidden.size) {
      const kept = new Uint32Array(source.length);
      let length = 0;
      for (let b = 0; b < buildings.info.length; b++) {
        if (this.hidden.has(b)) continue;
        const first = buildings.ranges[b * 4 + 2]!;
        const count = buildings.ranges[b * 4 + 3]!;
        kept.set(source.subarray(first, first + count), length);
        length += count;
      }
      index = kept.subarray(0, length);
    }
    this.buildingMesh.geometry.setIndex(new THREE.BufferAttribute(index, 1));
  }

  /** Finds the building under a ray, or -1. */
  pick(raycaster: THREE.Raycaster): number {
    if (!this.buildingMesh || !this.buildingMesh.visible) return -1;
    const hit = raycaster.intersectObject(this.buildingMesh, false)[0];
    if (!hit?.face) return -1;
    return this.data.buildings.owner[hit.face.a] ?? -1;
  }

  // ---- Animation ---------------------------------------------------------------------------

  /** Progress of the build-in animation: 0 = everything flat, 1 = fully grown. */
  setGrowth(t: number): void {
    this.grow.uGrow.value = t;
    this.root.scale.y = 0.02 + 0.98 * (1 - (1 - Math.min(1, t * 2.2)) ** 3);
  }

  dispose(): void {
    this.root.traverse((object) => {
      const mesh = object as THREE.Mesh;
      mesh.geometry?.dispose();
      const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(material)) for (const m of material) m.dispose();
      else material?.dispose();
      (mesh.customDepthMaterial as THREE.Material | undefined)?.dispose();
    });
    this.root.removeFromParent();
  }
}
