import { reverseGeocode } from "./core/api";
import { Engine, EngineError } from "./core/engine";
import { type MessageKey, setLanguage, t } from "./core/i18n";
import {
  type AppState,
  buildParams,
  type Store,
  sameBuild,
  sameSource,
  savePreferences,
  writeUrl,
} from "./core/store";
import type { BuildParams, DioramaData, LayerId, PrintParams } from "./core/types";
import { write3mf, writeStl } from "./export/print";
import { formatCoordinates } from "./geo/coords";
import { Diorama, type DioramaStyle } from "./scene/diorama";
import { type ColorKey, resolveTheme, themeColor } from "./scene/themes";
import { Viewer } from "./scene/viewer";
import {
  type Caption,
  createBrand,
  createCaption,
  createInspector,
  createStatus,
  createViewBar,
  type Inspector,
  type Status,
  type ViewBar,
} from "./ui/chrome";
import { createDock } from "./ui/dock";
import { debounce, download, h } from "./ui/dom";
import { createSearch, type PickedPlace } from "./ui/search";
import { createAreaSection } from "./ui/sections/area";
import { createExportSection } from "./ui/sections/export";
import { createLayersSection } from "./ui/sections/layers";
import { createLightSection } from "./ui/sections/light";
import { createStyleSection } from "./ui/sections/style";

const PRINT_COLOR: Record<LayerId, ColorKey> = {
  base: "ground",
  ground: "ground",
  urban: "urban",
  farmland: "farmland",
  sand: "sand",
  rock: "rock",
  ice: "ice",
  green: "green",
  forest: "forest",
  water: "water",
  sport: "sport",
  paved: "paved",
  paths: "paths",
  roads: "roads",
  rail: "rail",
  buildings: "walls",
  trees: "trees",
};

function slugify(text: string): string {
  const slug = text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `pop3d-${slug || "diorama"}`;
}

/** Wires the state, the geometry worker, the 3D viewer and the interface together. */
export class App {
  private engine = new Engine();
  private viewer: Viewer;
  private diorama: Diorama | null = null;
  private built: BuildParams | null = null;
  private ui!: HTMLElement;
  private caption!: Caption;
  private status!: Status;
  private viewBar!: ViewBar;
  private inspector!: Inspector;
  private layersSection: HTMLElement | null = null;
  private wide = matchMedia("(min-width: 901px)");
  private emphasisTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly root: HTMLElement,
    private readonly store: Store,
  ) {
    const viewport = h("div", { class: "viewport" });
    root.append(viewport);
    this.viewer = new Viewer(viewport, store.state.view);
    this.viewer.onFrame = (heading) => this.viewBar?.setHeading(heading);
    this.viewer.onInteract = () => {
      this.root.querySelector(".onboarding")?.classList.add("is-gone");
      if (this.store.state.view.autoRotate) {
        this.store.set({ view: { ...this.store.state.view, autoRotate: false } });
      }
    };
    this.applyTheme();
    this.mountInterface();
    this.bindState();
    this.bindPointer(viewport);
    this.bindKeyboard();
    this.wide.addEventListener("change", () => this.updateInsets(false));
  }

  // ---- Interface -----------------------------------------------------------------------------

  private mountInterface(): void {
    this.ui?.remove();
    const { store } = this;
    this.caption = createCaption(() => store.set({ lang: store.state.lang === "it" ? "en" : "it" }));
    this.status = createStatus();
    this.inspector = createInspector({
      close: () => this.selectBuilding(-1),
      hideBuilding: () => {
        if (!this.diorama || this.diorama.selection < 0) return;
        this.diorama.setBuildingHidden(this.diorama.selection, true);
        this.selectBuilding(-1);
        this.viewer.refresh();
        this.layersSection?.dispatchEvent(new Event("pop3d:refresh"));
      },
    });
    this.viewBar = createViewBar({
      zoom: (factor) => this.viewer.zoomBy(factor),
      home: () => this.viewer.flyTo("home"),
      top: () => this.viewer.flyTo("top"),
      north: () => this.viewer.faceNorth(),
      toggleRotate: () =>
        store.set({ view: { ...store.state.view, autoRotate: !store.state.view.autoRotate } }),
      fullscreen: () => {
        if (document.fullscreenElement) void document.exitFullscreen();
        else void document.documentElement.requestFullscreen?.();
      },
      hideUi: () => this.setInterfaceHidden(true),
    });
    this.viewBar.setRotating(store.state.view.autoRotate);

    const search = createSearch(
      store,
      (place) => this.goTo(place),
      (message) => this.status.toast(message),
    );
    this.focusSearch = search.focus;

    const dock = createDock(store, {
      area: () =>
        createAreaSection(store, {
          generate: () => void this.generate(),
          move: (lat, lon) => store.set({ area: { ...store.state.area, lat, lon }, place: null }),
        }),
      style: () => createStyleSection(store),
      layers: () => {
        this.layersSection = createLayersSection(store, {
          data: () => this.diorama?.data ?? null,
          emphasize: (layer) => this.emphasize(layer),
          hiddenBuildings: () => this.diorama?.hiddenBuildings ?? 0,
          restoreBuildings: () => {
            this.diorama?.showAllBuildings();
            this.viewer.refresh();
            this.layersSection?.dispatchEvent(new Event("pop3d:refresh"));
          },
        });
        return this.layersSection;
      },
      light: () => createLightSection(store),
      export: () =>
        createExportSection(store, {
          data: () => this.diorama?.data ?? null,
          image: (scale, transparent) => void this.exportImage(scale, transparent),
          model: (format) => void this.exportModel(format),
          print: (format, params) => void this.exportPrint(format, params),
        }),
    });

    const hint = h(
      "div",
      { class: "onboarding card" },
      matchMedia("(pointer: coarse)").matches ? t("hint.touch") : t("hint.controls"),
    );
    this.ui = h(
      "div",
      { class: "ui" },
      createBrand(),
      search.element,
      dock,
      this.inspector.element,
      this.caption.element,
      this.viewBar.element,
      hint,
      this.status.element,
    );
    this.root.append(this.ui);
    setTimeout(() => hint.classList.add("is-gone"), 14_000);

    if (this.diorama) {
      this.caption.setPlace(store.state.place, false);
      this.caption.setData(store.state, this.diorama.data);
    } else {
      this.caption.setPlace(store.state.place, true);
    }
    this.updateInsets(false);
  }

  private focusSearch: () => void = () => {};

  private setInterfaceHidden(hidden: boolean): void {
    this.ui.classList.toggle("is-hidden", hidden);
    if (hidden) this.viewer.setInsets({ left: 0, right: 0, top: 0, bottom: 0 });
    else this.updateInsets(true);
  }

  /** Keeps the model centred in the part of the window the panel leaves free. */
  private updateInsets(animate: boolean): void {
    const open = this.store.state.panel !== null;
    this.root.classList.toggle("has-panel", open);
    if (this.wide.matches) {
      this.viewer.setInsets({ left: 0, right: open ? 364 : 0, top: 40, bottom: 0 }, animate);
    } else {
      this.viewer.setInsets({ left: 0, right: 0, top: 60, bottom: open ? innerHeight * 0.48 : 110 }, animate);
    }
  }

  // ---- State -> scene ------------------------------------------------------------------------

  private style(): DioramaStyle {
    const { theme, colors, buildingColors, edges, faceted } = this.store.state;
    return { theme: resolveTheme(theme, colors), buildingColors, edges, faceted };
  }

  private applyTheme(): void {
    const style = this.style();
    document.documentElement.dataset.ui = style.theme.dark ? "dark" : "light";
    document.documentElement.style.setProperty("--backdrop", style.theme.background[1]);
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", style.theme.background[0]);
    this.viewer.setTheme(style.theme);
    this.diorama?.applyStyle(style);
  }

  private visibility(): Record<LayerId, boolean> {
    const hidden = new Set(this.store.state.hidden);
    const out = {} as Record<LayerId, boolean>;
    for (const layer of Object.keys(PRINT_COLOR) as LayerId[]) out[layer] = !hidden.has(layer);
    return out;
  }

  private bindState(): void {
    const { store } = this;
    const persist = debounce(() => savePreferences(store.state), 400);
    const rebuild = debounce(() => void this.generate(), 220);

    store.subscribe((state, changed) => {
      if (changed.has("theme") || changed.has("colors")) this.applyTheme();
      if (changed.has("buildingColors") || changed.has("edges") || changed.has("faceted")) {
        this.diorama?.applyStyle(this.style());
        this.viewer.refresh(false);
      }
      if (changed.has("hidden") || changed.has("solo")) {
        this.diorama?.setVisibility(this.visibility(), state.solo);
        this.viewer.refresh();
      }
      if (changed.has("view")) {
        this.viewer.applySettings(state.view);
        this.viewBar.setRotating(state.view.autoRotate);
      }
      if (changed.has("panel")) {
        this.updateInsets(true);
        // Leaving the layer list must not leave a layer highlighted.
        this.emphasize(null);
      }
      if (changed.has("lang")) {
        setLanguage(state.lang);
        this.mountInterface();
      }
      if (changed.has("area") || changed.has("detail") || changed.has("relief") || changed.has("roofs")) {
        const params = buildParams(state);
        if (this.built && sameSource(params, this.built)) {
          // Same ground, different settings: the data is cached, so rebuild straight away.
          if (state.stale) store.set({ stale: false });
          if (!sameBuild(params, this.built)) rebuild();
        } else if (this.built && !state.stale) {
          store.set({ stale: true });
        }
      }
      if (changed.has("theme") && this.built) history.replaceState(null, "", writeUrl(state));
      persist();
    });
  }

  // ---- Building ------------------------------------------------------------------------------

  /** Moves to a place picked in the search box and builds it. */
  goTo(place: PickedPlace): void {
    const { area } = this.store.state;
    const span = place.span;
    this.store.set({
      area: {
        ...area,
        lat: place.lat,
        lon: place.lon,
        width: span ?? area.width,
        depth: span ? span : area.depth,
      },
      freeAspect: span ? false : this.store.state.freeAspect,
      relief: place.relief ?? this.store.state.relief,
      place: { name: place.name, detail: place.detail },
    });
    void this.generate();
  }

  async generate(): Promise<void> {
    const { store } = this;
    const params = buildParams(store.state);
    const fresh = !this.built || !sameSource(params, this.built);
    store.set({ busy: true });
    this.selectBuilding(-1);
    if (fresh) this.caption.setPlace(store.state.place, true);
    try {
      const data = await this.engine.build(params, (stage, ratio) => {
        // Rebuilds from cached data are too quick to deserve a progress bar.
        if (fresh) this.status.progress(stage, ratio);
      });
      this.show(data, fresh);
    } catch (error) {
      if (error instanceof EngineError && error.code === "superseded") return;
      this.status.finish();
      store.set({ busy: false });
      const code = error instanceof EngineError ? error.code : "internal";
      const key = `error.${code}` as MessageKey;
      const known = ["network", "rate_limited", "too_large", "upstream", "internal"].includes(code);
      this.status.toast(t(known ? key : "error.internal"), {
        label: t("error.retry"),
        run: () => void this.generate(),
      });
      if (this.diorama) this.caption.setPlace(store.state.place, false);
    }
  }

  private show(data: DioramaData, fresh: boolean): void {
    const { store } = this;
    this.status.finish();
    const diorama = new Diorama(data, this.style());
    diorama.setVisibility(this.visibility(), store.state.solo);
    this.viewer.setDiorama(diorama, { animate: fresh, keepView: !fresh });
    this.diorama = diorama;
    this.built = data.params;
    store.set({ busy: false, stale: false, revision: store.state.revision + 1 });
    this.caption.setPlace(store.state.place ?? this.fallbackPlace(), false);
    this.caption.setData(store.state, data);
    history.replaceState(null, "", writeUrl(store.state));
    document.title = `${(store.state.place ?? this.fallbackPlace()).name} · pop3d`;
    if (!store.state.place) void this.nameCurrentPlace(data.params);
  }

  private fallbackPlace(): { name: string; detail: string } {
    return { name: formatCoordinates(this.store.state.area), detail: t("caption.here") };
  }

  /** Looks up what the centre of an unnamed area is called. */
  private async nameCurrentPlace(params: BuildParams): Promise<void> {
    const place = await reverseGeocode(params.area.lat, params.area.lon);
    if (!place || this.built !== params || this.store.state.place) return;
    this.store.set({ place: { name: place.name, detail: place.detail } });
    this.caption.setPlace(this.store.state.place, false);
    history.replaceState(null, "", writeUrl(this.store.state));
    document.title = `${place.name} · pop3d`;
  }

  // ---- Emphasis and selection ----------------------------------------------------------------

  private emphasize(layer: LayerId | null): void {
    clearTimeout(this.emphasisTimer);
    // A short delay avoids flicker while the pointer travels across the list.
    this.emphasisTimer = setTimeout(
      () => {
        this.diorama?.emphasize(layer);
        this.viewer.refresh(false);
      },
      layer ? 90 : 160,
    );
  }

  private selectBuilding(index: number): void {
    if (!this.diorama) return;
    if (this.diorama.selection === index) return;
    this.diorama.select(index);
    this.viewer.refresh(false);
    if (index >= 0) this.inspector.show(this.diorama.data.buildings.info[index]!);
    else this.inspector.hide();
  }

  private bindPointer(viewport: HTMLElement): void {
    let down: { x: number; y: number; time: number } | null = null;
    viewport.addEventListener("pointerdown", (event) => {
      down = event.button === 0 ? { x: event.clientX, y: event.clientY, time: performance.now() } : null;
    });
    viewport.addEventListener("pointerup", (event) => {
      if (!down) return;
      const moved = Math.hypot(event.clientX - down.x, event.clientY - down.y);
      const quick = performance.now() - down.time < 450;
      down = null;
      // A click, not a drag: pick whatever building is under the pointer.
      if (moved > 5 || !quick) return;
      if (this.ui.classList.contains("is-hidden")) {
        this.setInterfaceHidden(false);
        return;
      }
      this.selectBuilding(this.viewer.pickBuilding(event.clientX, event.clientY));
    });
  }

  private bindKeyboard(): void {
    window.addEventListener("keydown", (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.matches("input, textarea, select") || event.metaKey || event.ctrlKey || event.altKey) return;
      const { store, viewer } = this;
      const panels = ["area", "style", "layers", "light", "export"] as const;
      switch (event.key) {
        case "/":
          event.preventDefault();
          this.focusSearch();
          break;
        case "Escape":
          if (this.ui.classList.contains("is-hidden")) this.setInterfaceHidden(false);
          else if (this.diorama && this.diorama.selection >= 0) this.selectBuilding(-1);
          else if (store.state.panel) store.set({ panel: null });
          break;
        case "h":
          this.setInterfaceHidden(!this.ui.classList.contains("is-hidden"));
          break;
        case "r":
          viewer.flyTo("home");
          break;
        case "t":
          viewer.flyTo("top");
          break;
        case "n":
          viewer.faceNorth();
          break;
        case " ":
          event.preventDefault();
          store.set({ view: { ...store.state.view, autoRotate: !store.state.view.autoRotate } });
          break;
        case "+":
        case "=":
          viewer.zoomBy(0.7);
          break;
        case "-":
          viewer.zoomBy(1.4);
          break;
        case "1":
        case "2":
        case "3":
        case "4":
        case "5": {
          const panel = panels[Number(event.key) - 1]!;
          store.set({ panel: store.state.panel === panel ? null : panel });
          break;
        }
      }
    });
  }

  // ---- Export --------------------------------------------------------------------------------

  private fileName(): string {
    return slugify(this.store.state.place?.name ?? "diorama");
  }

  private async exporting(task: () => Promise<{ blob: Blob; name: string }>): Promise<void> {
    if (!this.diorama) {
      this.status.toast(t("export.empty"));
      return;
    }
    this.status.toast(t("export.working"), undefined, 1800);
    // Give the toast a frame to appear before the heavy work starts.
    await new Promise((resolve) => setTimeout(resolve, 60));
    try {
      const { blob, name } = await task();
      download(blob, name);
      this.status.toast(t("export.done", { name }));
    } catch (error) {
      console.error("[pop3d] export failed", error);
      this.status.toast(t("export.failed"));
    }
  }

  private exportImage(scale: number, transparent: boolean): Promise<void> {
    return this.exporting(async () => ({
      blob: await this.viewer.capture(scale, transparent),
      name: `${this.fileName()}.png`,
    }));
  }

  private exportModel(format: "glb" | "obj"): Promise<void> {
    return this.exporting(async () => {
      const { writeGlb, writeObj } = await import("./export/model");
      const meshes = this.diorama!.exportMeshes();
      const title = this.store.state.place?.name ?? "pop3d";
      const slug = this.fileName();
      return format === "glb"
        ? { blob: await writeGlb(meshes, title), name: `${slug}.glb` }
        : { blob: writeObj(meshes, slug, title), name: `${slug}-obj.zip` };
    });
  }

  private exportPrint(format: "stl" | "3mf", params: PrintParams): Promise<void> {
    return this.exporting(async () => {
      const { parts } = await this.engine.print(params);
      const title = this.store.state.place?.name ?? "pop3d";
      const slug = this.fileName();
      if (format === "stl") return { blob: writeStl(parts, title), name: `${slug}.stl` };
      const theme = this.style().theme;
      const colors = {} as Record<LayerId, string>;
      const names = {} as Record<LayerId, string>;
      for (const layer of Object.keys(PRINT_COLOR) as LayerId[]) {
        colors[layer] = themeColor(theme, PRINT_COLOR[layer]);
        names[layer] = t(`layer.${layer}` as MessageKey);
      }
      return { blob: write3mf(parts, colors, names, title), name: `${slug}.3mf` };
    });
  }

  get state(): AppState {
    return this.store.state;
  }
}
