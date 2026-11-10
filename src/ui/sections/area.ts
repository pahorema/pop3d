import { formatDistance, formatNumber, type MessageKey, t } from "../../core/i18n";
import { MAX_SPAN, MIN_SPAN, type Store } from "../../core/store";
import type { Detail, ShapeKind } from "../../core/types";
import { shapeArea } from "../../geo/projection";
import { button, section, segmented, slider, toggle } from "../controls";
import { h } from "../dom";
import { createMinimap } from "../minimap";

/** Rounds an extent to a tidy number: finer steps for small areas. */
function tidy(metres: number): number {
  const step = metres < 400 ? 10 : metres < 1000 ? 50 : 100;
  return Math.min(MAX_SPAN, Math.max(MIN_SPAN, Math.round(metres / step) * step));
}

const spanScale = {
  toValue: (position: number) => tidy(MIN_SPAN * (MAX_SPAN / MIN_SPAN) ** (position / 1000)),
  toPosition: (value: number) => (Math.log(value / MIN_SPAN) / Math.log(MAX_SPAN / MIN_SPAN)) * 1000,
};

export function createAreaSection(
  store: Store,
  actions: { generate(): void; move(lat: number, lon: number): void },
): HTMLElement {
  const { state } = store;
  const setArea = (patch: Partial<typeof state.area>) =>
    store.set({ area: { ...store.state.area, ...patch } });

  const shape = segmented<ShapeKind>(
    t("area.shape"),
    [
      { value: "circle", label: t("area.shape.circle"), icon: "shapeCircle" },
      { value: "rounded", label: t("area.shape.rounded"), icon: "shapeRounded" },
      { value: "square", label: t("area.shape.square"), icon: "shapeSquare" },
      { value: "hexagon", label: t("area.shape.hexagon"), icon: "shapeHexagon" },
    ],
    state.area.shape,
    (value) => setArea({ shape: value }),
  );

  const width = slider({
    label: state.freeAspect ? t("area.width") : t("area.size"),
    min: MIN_SPAN,
    max: MAX_SPAN,
    step: 10,
    value: state.area.width,
    scale: spanScale,
    format: formatDistance,
    onInput: (value) => setArea(store.state.freeAspect ? { width: value } : { width: value, depth: value }),
  });
  const depth = slider({
    label: t("area.depth"),
    min: MIN_SPAN,
    max: MAX_SPAN,
    step: 10,
    value: state.area.depth,
    scale: spanScale,
    format: formatDistance,
    onInput: (value) => setArea({ depth: value }),
  });
  depth.element.hidden = !state.freeAspect;
  const widthLabel = width.element.querySelector(".slider-label")!;
  const free = toggle(t("area.free"), null, state.freeAspect, (value) => {
    const { area } = store.state;
    store.set({ freeAspect: value, area: value ? area : { ...area, depth: area.width } });
  });

  const detailHint = h("p", { class: "hint" });
  const detail = segmented<Detail>(
    t("area.detail"),
    [
      { value: 0, label: t("area.detail.0") },
      { value: 1, label: t("area.detail.1") },
      { value: 2, label: t("area.detail.2") },
    ],
    state.detail,
    (value) => store.set({ detail: value }),
  );

  const relief = slider({
    label: t("area.relief"),
    min: 0,
    max: 3,
    step: 0.1,
    value: state.relief,
    format: (value) => (value === 0 ? t("area.relief.flat") : `${formatNumber(value, 1)}×`),
    hints: [t("area.relief.flat"), "3×"],
    onChange: (value) => store.set({ relief: Math.round(value * 10) / 10 }),
  });

  const roofs = toggle(t("area.roofs"), t("area.roofs.hint"), state.roofs, (value) =>
    store.set({ roofs: value }),
  );

  const surface = h("span", { class: "meta" });
  const warning = h("div", { class: "note", hidden: true }, t("area.large"));
  const generate = button(t("area.generate"), actions.generate, {
    variant: "primary",
    className: "button-wide",
    icon: "cube",
  });
  const generateLabel = generate.querySelector(".button-label")!;

  const refresh = (): void => {
    const current = store.state;
    const { area } = current;
    shape.set(area.shape);
    width.set(area.width);
    depth.set(area.depth);
    depth.element.hidden = !current.freeAspect;
    widthLabel.textContent = current.freeAspect ? t("area.width") : t("area.size");
    free.set(current.freeAspect);
    detail.set(current.detail);
    detailHint.textContent = t(`area.detail.hint.${current.detail}` as MessageKey);
    relief.set(current.relief);
    roofs.set(current.roofs);
    const squareKm = shapeArea(area.shape, area.width, area.depth) / 1e6;
    surface.textContent = `${formatNumber(squareKm, squareKm < 1 ? 2 : 1)} km²`;
    warning.hidden = squareKm < 6;
    generate.disabled = current.busy || (!current.stale && current.revision > 0);
    generateLabel.textContent = current.busy
      ? `${t("progress.geometry")}…`
      : current.stale || current.revision === 0
        ? current.revision === 0
          ? t("area.generate")
          : t("area.update")
        : t("area.current");
  };
  refresh();
  store.on(["area", "freeAspect", "detail", "relief", "roofs", "busy", "stale", "revision"], refresh);

  return h(
    "div",
    null,
    section(null, createMinimap(store, actions.move)),
    section(
      t("area.shape"),
      shape.element,
      width.element,
      depth.element,
      free.element,
      h("div", { class: "field-row" }, h("span", null, t("area.surface")), surface),
    ),
    section(t("area.detail"), detail.element, detailHint, relief.element, roofs.element),
    section(null, warning, generate),
  );
}
