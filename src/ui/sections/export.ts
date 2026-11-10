import { type ModelFormat, modelQuery } from "../../../shared/model-api";
import { formatNumber, type MessageKey, t } from "../../core/i18n";
import type { Store } from "../../core/store";
import type { DioramaData, LayerId, PrintParams } from "../../core/types";
import { button, section, segmented, slider, toggle } from "../controls";
import { h } from "../dom";

export interface ExportActions {
  data(): DioramaData | null;
  notify(message: string): void;
  image(scale: number, transparent: boolean): void;
  model(format: "glb" | "obj"): void;
  print(format: "stl" | "3mf", params: PrintParams): void;
}

const PRINT_LAYERS: LayerId[] = [
  "buildings",
  "roads",
  "paths",
  "rail",
  "water",
  "green",
  "forest",
  "paved",
  "farmland",
  "sand",
  "rock",
  "ice",
  "sport",
  "trees",
];

const DEFAULT_PRINT_LAYERS: LayerId[] = ["buildings", "roads", "paths", "rail", "water"];

export function createExportSection(store: Store, actions: ExportActions): HTMLElement {
  let imageScale = 2;
  let transparent = false;
  const print: PrintParams = {
    sizeMm: 150,
    baseMm: 3,
    zScale: 1.5,
    minFeatureMm: 0.4,
    layers: ["base", ...DEFAULT_PRINT_LAYERS],
  };

  const scaleFact = h("span", { class: "fact-value" });
  const sizeFact = h("span", { class: "fact-value" });
  const facts = h(
    "div",
    { class: "print-facts" },
    h("div", { class: "fact" }, h("span", { class: "fact-label" }, t("export.print.scale")), scaleFact),
    h("div", { class: "fact" }, h("span", { class: "fact-label" }, t("export.print.dimensions")), sizeFact),
  );

  const updateFacts = (): void => {
    const data = actions.data();
    const area = data?.params.area ?? store.state.area;
    const span = Math.max(area.width, area.depth);
    const scale = print.sizeMm / span;
    scaleFact.textContent = `1:${formatNumber(Math.round(1000 / scale / 10) * 10)}`;
    const height = data ? print.baseMm + data.topY * scale * print.zScale : print.baseMm;
    sizeFact.textContent = `${Math.round(area.width * scale)} × ${Math.round(area.depth * scale)} × ${Math.round(height)} ${t("unit.mm")}`;
  };

  const chips = h("div", { class: "chips" });
  for (const layer of PRINT_LAYERS) {
    const chip = h(
      "button",
      {
        class: `chip${print.layers.includes(layer) ? " is-active" : ""}`,
        type: "button",
        "aria-pressed": String(print.layers.includes(layer)),
        onclick: () => {
          const on = !print.layers.includes(layer);
          print.layers = on ? [...print.layers, layer] : print.layers.filter((id) => id !== layer);
          chip.classList.toggle("is-active", on);
          chip.setAttribute("aria-pressed", String(on));
        },
      },
      t(`layer.${layer}` as MessageKey),
    );
    chips.append(chip);
  }

  const element = h(
    "div",
    null,
    section(
      t("export.image"),
      h("p", { class: "hint" }, t("export.image.hint")),
      segmented(
        t("export.image.scale"),
        [
          { value: 1, label: "1×" },
          { value: 2, label: "2×" },
          { value: 4, label: "4×" },
        ],
        imageScale,
        (value) => {
          imageScale = value;
        },
      ).element,
      toggle(t("export.image.transparent"), null, transparent, (value) => {
        transparent = value;
      }).element,
      button(t("export.image.download"), () => actions.image(imageScale, transparent), {
        icon: "image",
        className: "button-wide",
      }),
    ),
    section(
      t("export.model"),
      h("p", { class: "hint" }, t("export.model.hint")),
      h(
        "div",
        { class: "button-row" },
        button("GLB", () => actions.model("glb"), { icon: "cube" }),
        button("OBJ", () => actions.model("obj"), { icon: "cube" }),
      ),
    ),
    section(
      t("export.print"),
      h("p", { class: "hint" }, t("export.print.hint")),
      slider({
        label: t("export.print.size"),
        min: 40,
        max: 300,
        step: 5,
        value: print.sizeMm,
        format: (value) => `${value} ${t("unit.mm")}`,
        onInput: (value) => {
          print.sizeMm = value;
          updateFacts();
        },
      }).element,
      slider({
        label: t("export.print.base"),
        min: 1,
        max: 12,
        step: 0.5,
        value: print.baseMm,
        format: (value) => `${formatNumber(value, 1)} ${t("unit.mm")}`,
        onInput: (value) => {
          print.baseMm = value;
          updateFacts();
        },
      }).element,
      slider({
        label: t("export.print.boost"),
        min: 1,
        max: 3,
        step: 0.1,
        value: print.zScale,
        format: (value) => `${formatNumber(value, 1)}×`,
        onInput: (value) => {
          print.zScale = value;
          updateFacts();
        },
      }).element,
      facts,
      h("div", { class: "slider-label" }, t("export.print.layers")),
      chips,
      h(
        "div",
        { class: "button-row" },
        button("STL", () => actions.print("stl", { ...print }), { icon: "printer", variant: "primary" }),
        button("3MF", () => actions.print("3mf", { ...print }), { icon: "printer" }),
      ),
      h("p", { class: "hint" }, `${t("export.print.stl")}  ·  ${t("export.print.3mf")}`),
    ),
  );
  // The API link reproduces whatever is on screen: place, area, style, hidden layers, print setup.
  let apiFormat: ModelFormat = "glb";
  const apiLink = h("code", { class: "api-link" });
  const apiUrl = (): string => {
    const current = store.state;
    const area = actions.data()?.params.area ?? current.area;
    const printing = apiFormat === "stl" || apiFormat === "3mf";
    const query = modelQuery({
      lat: area.lat,
      lon: area.lon,
      shape: area.shape,
      width: area.width,
      depth: area.depth,
      detail: current.detail,
      relief: current.relief,
      roofs: current.roofs,
      theme: current.theme,
      colors: current.colors,
      buildings: current.buildingColors,
      hide: current.solo ? [] : current.hidden,
      layers: printing
        ? print.layers.filter((layer) => layer !== "base")
        : current.solo
          ? [current.solo, "base"]
          : null,
      ...(printing
        ? {
            printSize: print.sizeMm,
            printBase: print.baseMm,
            printZScale: print.zScale,
            printFeature: print.minFeatureMm,
          }
        : {}),
      lang: current.lang,
      format: apiFormat,
    });
    return `${location.origin}/api/model?${query}`;
  };
  const updateApi = (): void => {
    apiLink.textContent = apiUrl().replace(location.origin, "");
  };
  element.append(
    section(
      t("export.api"),
      h("p", { class: "hint" }, t("export.api.hint")),
      segmented<ModelFormat>(
        t("export.api"),
        [
          { value: "glb", label: "GLB" },
          { value: "obj", label: "OBJ" },
          { value: "stl", label: "STL" },
          { value: "3mf", label: "3MF" },
          { value: "json", label: "JSON" },
        ],
        apiFormat,
        (value) => {
          apiFormat = value;
          updateApi();
        },
      ).element,
      apiLink,
      h(
        "div",
        { class: "button-row" },
        button(
          t("export.api.copy"),
          () => {
            updateApi();
            void navigator.clipboard?.writeText(apiUrl()).then(
              () => actions.notify(t("export.api.copied")),
              () => actions.notify(apiUrl()),
            );
          },
          { icon: "link" },
        ),
        h(
          "a",
          { class: "button button-ghost", href: "/api", target: "_blank", rel: "noopener" },
          h("span", { class: "button-label" }, t("export.api.docs")),
        ),
      ),
    ),
  );
  element.addEventListener("pointerenter", updateApi);
  updateApi();
  updateFacts();
  store.on(["revision", "area"], updateFacts);
  store.on(
    [
      "revision",
      "area",
      "detail",
      "relief",
      "roofs",
      "theme",
      "colors",
      "buildingColors",
      "hidden",
      "solo",
      "lang",
    ],
    updateApi,
  );
  return element;
}
