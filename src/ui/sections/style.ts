import { type MessageKey, t } from "../../core/i18n";
import type { Store } from "../../core/store";
import type { BuildingColorMode } from "../../scene/diorama";
import { COLOR_KEYS, type ColorKey, resolveTheme, THEMES, type Theme, themeColor } from "../../scene/themes";
import { section, segmented, toggle } from "../controls";
import { clear, h } from "../dom";

/** A tiny isometric vignette painted with the theme's own colours. */
function themeArt(theme: Theme): string {
  const { layers, walls, roofs, trees, background } = theme;
  const block = (x: number, y: number, w: number, d: number, height: number, wall: string, roof: string) => {
    const top = y - height;
    return (
      `<path d="M${x} ${y}l${w} ${w / 2}v${-height}l${-w} ${-w / 2}Z" fill="${wall}"/>` +
      `<path d="M${x + w} ${y + w / 2}l${d} ${-d / 2}v${-height}l${-d} ${d / 2}Z" fill="${wall}" opacity=".78"/>` +
      `<path d="M${x} ${top}l${w} ${w / 2}l${d} ${-d / 2}l${-w} ${-w / 2}Z" fill="${roof}"/>`
    );
  };
  return `<svg class="theme-art" viewBox="0 0 160 90" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
    <defs><linearGradient id="bg-${theme.id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${background[0]}"/><stop offset="1" stop-color="${background[1]}"/></linearGradient>
    <clipPath id="clip-${theme.id}"><ellipse cx="80" cy="50" rx="62" ry="31"/></clipPath></defs>
    <rect width="160" height="90" fill="url(#bg-${theme.id})"/>
    <ellipse cx="80" cy="60" rx="62" ry="31" fill="${layers.base}"/>
    <rect x="18" y="50" width="124" height="10" fill="${layers.base}"/>
    <ellipse cx="80" cy="50" rx="62" ry="31" fill="${layers.ground}"/>
    <g clip-path="url(#clip-${theme.id})">
      <path d="M10 44 62 18l14 7-52 26Z" fill="${layers.water}"/>
      <path d="M92 70 150 41v22l-36 18Z" fill="${layers.green}"/>
      <path d="M0 62 160 -18v7L0 69Z" fill="${layers.roads}"/>
      <path d="M48 20 140 66h-13L41 23.500000000000004Z" fill="${layers.roads}"/>
    </g>
    ${block(58, 46, 16, 14, 13, walls[0]!, roofs[0]!)}
    ${block(92, 30, 12, 12, 22, walls[1 % walls.length]!, roofs[1 % roofs.length]!)}
    ${block(34, 52, 12, 10, 8, walls[2 % walls.length]!, roofs[2 % roofs.length]!)}
    <circle cx="118" cy="56" r="5" fill="${trees.crowns[0]}"/><circle cx="128" cy="52" r="4" fill="${trees.crowns[1 % trees.crowns.length]}"/>
  </svg>`;
}

export function createStyleSection(store: Store): HTMLElement {
  const themes = h("div", { class: "themes" });
  const cards = new Map<string, HTMLButtonElement>();
  for (const theme of THEMES) {
    const card = h(
      "button",
      { class: "theme", type: "button", onclick: () => store.set({ theme: theme.id, colors: {} }) },
      h("span", { html: themeArt(theme) }),
      h("span", { class: "theme-name" }, t(`style.theme.${theme.id}` as MessageKey)),
    );
    cards.set(theme.id, card);
    themes.append(card);
  }

  const buildingColors = segmented<BuildingColorMode>(
    t("style.buildings"),
    [
      { value: "theme", label: t("style.buildings.theme") },
      { value: "height", label: t("style.buildings.height") },
      { value: "kind", label: t("style.buildings.kind") },
    ],
    store.state.buildingColors,
    (value) => store.set({ buildingColors: value }),
  );
  const edges = toggle(t("style.edges"), t("style.edges.hint"), store.state.edges, (value) =>
    store.set({ edges: value }),
  );
  const faceted = toggle(t("style.faceted"), t("style.faceted.hint"), store.state.faceted, (value) =>
    store.set({ faceted: value }),
  );

  const swatches = h("div", { class: "swatches" });
  const reset = h("button", { type: "button", onclick: () => store.set({ colors: {} }) }, t("style.reset"));
  const colorsTitle = h("h3", { class: "group-title" }, t("style.colors"), reset);

  const drawSwatches = (): void => {
    const { theme: id, colors } = store.state;
    const theme = resolveTheme(id, colors);
    clear(swatches);
    for (const key of COLOR_KEYS) {
      const value = themeColor(theme, key);
      const code = h("span", { class: "swatch-code" }, value);
      const chip = h("span", { class: "swatch-chip", style: `background:${value}` });
      const input = h("input", { type: "color", value, "aria-label": t(`color.${key}` as MessageKey) });
      // Live preview while the picker is open; the palette list itself is redrawn on commit.
      input.addEventListener("input", () => {
        chip.style.background = input.value;
        code.textContent = input.value;
        store.set({ colors: { ...store.state.colors, [key as ColorKey]: input.value } });
      });
      chip.append(input);
      swatches.append(
        h(
          "label",
          { class: `swatch${colors[key] ? " is-custom" : ""}` },
          chip,
          h("span", { class: "swatch-name" }, t(`color.${key}` as MessageKey)),
          code,
        ),
      );
    }
    reset.hidden = Object.keys(colors).length === 0;
  };

  const refresh = (): void => {
    const current = store.state;
    for (const [id, card] of cards) card.classList.toggle("is-active", id === current.theme);
    buildingColors.set(current.buildingColors);
    edges.set(current.edges);
    faceted.set(current.faceted);
  };
  refresh();
  drawSwatches();
  store.on(["theme", "buildingColors", "edges", "faceted"], refresh);
  store.on(["theme"], drawSwatches);
  store.on(["colors"], (state) => {
    // Redraw after a reset; while a picker is open the inputs must stay in place.
    if (!Object.keys(state.colors).length) drawSwatches();
    else {
      reset.hidden = false;
      swatches.querySelectorAll(".swatch").forEach((node, index) => {
        node.classList.toggle("is-custom", Boolean(state.colors[COLOR_KEYS[index]!]));
      });
    }
  });

  return h(
    "div",
    null,
    section(t("style.themes"), themes),
    section(t("style.buildings"), buildingColors.element, edges.element, faceted.element),
    h("section", { class: "group" }, colorsTitle, swatches),
  );
}
