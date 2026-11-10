import type * as Leaflet from "leaflet";
import { t } from "../core/i18n";
import type { Store } from "../core/store";
import type { Area } from "../core/types";
import { shapeRing } from "../geo/projection";
import { iconButton } from "./controls";
import { h } from "./dom";

const TILES = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";

/** Metres covered by one pixel of a web-mercator map. */
const metresPerPixel = (lat: number, zoom: number) =>
  (156_543.034 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom;

/**
 * A small slippy map with the diorama outline pinned to its centre: dragging the map under the
 * outline is how the area is moved, like choosing a spot with a viewfinder.
 */
export function createMinimap(store: Store, onMove: (lat: number, lon: number) => void): HTMLElement {
  const view = h("div", { class: "minimap-view" });
  const outline = h("div", { class: "minimap-outline" });
  const element = h(
    "div",
    { class: "minimap" },
    view,
    outline,
    h("div", { class: "minimap-hint" }, t("area.map")),
    h(
      "div",
      { class: "minimap-credit" },
      h(
        "a",
        { href: "https://www.openstreetmap.org/copyright", target: "_blank", rel: "noopener" },
        "© OpenStreetMap",
      ),
    ),
  );

  let map: Leaflet.Map | null = null;
  // Set while the map is being moved by code, so that programmatic moves do not echo back.
  let syncing = false;

  const drawOutline = (): void => {
    if (!map) return;
    const { area } = store.state;
    const scale = 1 / metresPerPixel(area.lat, map.getZoom());
    const ring = shapeRing(area.shape, area.width, area.depth);
    const width = element.clientWidth;
    const height = element.clientHeight;
    let path = "";
    for (let i = 0; i < ring.length; i += 2) {
      path += `${i ? "L" : "M"}${(width / 2 + ring[i]! * scale).toFixed(1)} ${(height / 2 - ring[i + 1]! * scale).toFixed(1)}`;
    }
    outline.innerHTML = `<svg width="${width}" height="${height}"><path d="${path}Z"/><circle cx="${width / 2}" cy="${height / 2}" r="2.5"/></svg>`;
  };

  /** Zoom at which the outline fills a comfortable part of the map. */
  const fitZoom = (area: Area): number => {
    const available = Math.min(element.clientWidth, element.clientHeight * 1.25) * 0.62;
    const span = Math.max(area.width, area.depth);
    return Math.log2((156_543.034 * Math.cos((area.lat * Math.PI) / 180) * available) / span);
  };

  let lastSpan = 0;
  const sync = (animate: boolean): void => {
    if (!map) return;
    const { area } = store.state;
    const centre = map.getCenter();
    const moved =
      map.latLngToContainerPoint(centre).distanceTo(map.latLngToContainerPoint([area.lat, area.lon])) > 1.5;
    const span = Math.max(area.width, area.depth);
    const resized = span !== lastSpan;
    lastSpan = span;
    // Refit only when the area jumped elsewhere or changed size: the user's own zoom is kept.
    if (moved || resized) {
      syncing = true;
      map.setView([area.lat, area.lon], fitZoom(area), { animate: animate && !moved });
      syncing = false;
    }
    drawOutline();
  };

  void import("leaflet").then((module) => {
    const L = (module as unknown as { default?: typeof Leaflet }).default ?? module;
    const { area } = store.state;
    lastSpan = Math.max(area.width, area.depth);
    map = L.map(view, {
      center: [area.lat, area.lon],
      zoom: fitZoom(area),
      zoomSnap: 0,
      zoomDelta: 0.5,
      wheelPxPerZoomLevel: 140,
      // Zooming keeps the centre still: only dragging moves the area.
      scrollWheelZoom: "center",
      touchZoom: "center",
      doubleClickZoom: "center",
      zoomControl: false,
      attributionControl: false,
      inertia: true,
      worldCopyJump: true,
      minZoom: 3,
      maxZoom: 19,
    });
    L.tileLayer(TILES, { maxZoom: 19 }).addTo(map);
    map.on("move zoom", drawOutline);
    map.on("dragstart", () => element.classList.add("is-touched"));
    map.on("moveend", () => {
      if (syncing || !map) return;
      // Report real moves only: the map nudges its centre by sub-pixel amounts on its own.
      const current = store.state.area;
      const centre = map.getCenter();
      const drift = map
        .latLngToContainerPoint(centre)
        .distanceTo(map.latLngToContainerPoint([current.lat, current.lon]));
      if (drift > 1.5) onMove(centre.lat, centre.lng);
    });
    drawOutline();
    new ResizeObserver(() => {
      map?.invalidateSize({ animate: false });
      sync(false);
    }).observe(element);
  });

  element.append(
    h(
      "div",
      { class: "minimap-tools" },
      iconButton("plus", t("view.zoomIn"), () => map?.zoomIn(1)),
      iconButton("minus", t("view.zoomOut"), () => map?.zoomOut(1)),
    ),
  );
  store.on(["area"], () => sync(true));
  return element;
}
