import { formatNumber, type MessageKey, t } from "../../core/i18n";
import type { Store } from "../../core/store";
import { type DioramaData, LAYERS, type LayerId } from "../../core/types";
import { type ColorKey, resolveTheme, themeColor } from "../../scene/themes";
import { iconButton } from "../controls";
import { clear, h } from "../dom";

export interface LayerActions {
  /** Diorama currently on screen, if any. */
  data(): DioramaData | null;
  emphasize(layer: LayerId | null): void;
  hiddenBuildings(): number;
  restoreBuildings(): void;
}

/** Layers from the most prominent down to the plinth. */
const ORDER: LayerId[] = [...LAYERS].reverse();

export function createLayersSection(store: Store, actions: LayerActions): HTMLElement {
  const list = h("div", { class: "layer-list", onpointerleave: () => actions.emphasize(null) });
  const showAll = h(
    "button",
    { type: "button", onclick: () => store.set({ hidden: [], solo: null }) },
    t("layers.showAll"),
  );
  const title = h("h3", { class: "group-title" }, t("layers.title"), showAll);
  const restored = h("div", { class: "note", hidden: true });

  const colorOf = (layer: LayerId): string => {
    const theme = resolveTheme(store.state.theme, store.state.colors);
    const key: ColorKey = layer === "buildings" ? "roofs" : layer;
    return themeColor(theme, key);
  };

  const count = (layer: LayerId, data: DioramaData): string => {
    if (layer === "buildings") return formatNumber(data.stats.buildings);
    if (layer === "trees") return formatNumber(data.stats.trees);
    return "";
  };

  const draw = (): void => {
    const { hidden, solo } = store.state;
    const data = actions.data();
    clear(list);
    for (const layer of ORDER) {
      const present = !data
        ? true
        : layer === "buildings"
          ? data.buildings.indices.length > 0
          : layer === "trees"
            ? data.trees.count > 0
            : Boolean(data.layers[layer]?.indices.length);
      const off = solo ? solo !== layer : hidden.includes(layer);
      const eye = iconButton(off ? "eyeOff" : "eye", off ? t("layers.show") : t("layers.hide"), () => {
        const current = store.state;
        if (current.solo) {
          // Leaving solo mode by toggling a layer: show everything except what is toggled off.
          store.set({ solo: null, hidden: current.solo === layer ? [layer] : [] });
          return;
        }
        store.set({
          hidden: current.hidden.includes(layer)
            ? current.hidden.filter((id) => id !== layer)
            : [...current.hidden, layer],
        });
      });
      const target = iconButton(
        "solo",
        solo === layer ? t("layers.unsolo") : t("layers.solo"),
        () => store.set({ solo: store.state.solo === layer ? null : layer }),
        solo === layer ? "is-active" : "",
      );
      list.append(
        h(
          "div",
          {
            class: `layer${off ? " is-off" : ""}${present ? "" : " is-missing"}`,
            onpointerenter: () => actions.emphasize(present && !off ? layer : null),
          },
          h("span", { class: "layer-dot", style: `background:${colorOf(layer)}` }),
          h("span", { class: "layer-name" }, t(`layer.${layer}` as MessageKey)),
          h("span", { class: "layer-count" }, present ? (data ? count(layer, data) : "") : t("layers.empty")),
          present && layer !== "base" ? target : null,
          present ? eye : null,
        ),
      );
    }
    showAll.hidden = hidden.length === 0 && solo === null;
    const manual = actions.hiddenBuildings();
    restored.hidden = manual === 0;
    if (manual) {
      clear(restored);
      restored.append(
        h("span", { style: "flex:1" }, t("layers.hiddenBuildings", { n: manual })),
        h(
          "button",
          { type: "button", style: "font-weight:600;color:var(--accent)", onclick: actions.restoreBuildings },
          t("layers.restoreBuildings"),
        ),
      );
    }
  };
  draw();
  store.on(["hidden", "solo", "theme", "colors", "revision"], draw);

  const element = h(
    "div",
    null,
    h("section", { class: "group" }, title, h("p", { class: "hint" }, t("layers.hint")), list, restored),
  );
  // Let other parts of the app (hiding a single building) ask for a redraw.
  element.addEventListener("pop3d:refresh", draw);
  return element;
}
