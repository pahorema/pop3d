import { type MessageKey, t } from "../core/i18n";
import type { PanelId, Store } from "../core/store";
import { icon } from "./controls";
import { h } from "./dom";
import type { IconName } from "./icons";

const TABS: { id: PanelId; icon: IconName }[] = [
  { id: "area", icon: "area" },
  { id: "style", icon: "style" },
  { id: "layers", icon: "layers" },
  { id: "light", icon: "light" },
  { id: "export", icon: "export" },
];

/** The tab strip and the panel that drops down from it. Sections are built on first use. */
export function createDock(store: Store, factories: Record<PanelId, () => HTMLElement>): HTMLElement {
  const sections = new Map<PanelId, HTMLElement>();
  const panel = h("div", { class: "panel", hidden: true });
  const tabs = h("div", { class: "tabs", role: "tablist" });
  const buttons = new Map<PanelId, HTMLButtonElement>();
  for (const tab of TABS) {
    const label = t(`panel.${tab.id}` as MessageKey);
    const node = h(
      "button",
      {
        class: "tab",
        type: "button",
        role: "tab",
        title: label,
        "aria-label": label,
        onclick: () => store.set({ panel: store.state.panel === tab.id ? null : tab.id }),
      },
      icon(tab.icon),
      h("span", { class: "tab-label" }, label),
    );
    buttons.set(tab.id, node);
    tabs.append(node);
  }
  const element = h("div", { class: "dock card" }, tabs, panel);

  const refresh = (): void => {
    const active = store.state.panel;
    element.classList.toggle("is-open", active !== null);
    for (const [id, node] of buttons) {
      node.classList.toggle("is-active", id === active);
      node.setAttribute("aria-selected", String(id === active));
    }
    panel.hidden = active === null;
    if (active === null) return;
    let section = sections.get(active);
    if (!section) {
      section = factories[active]();
      sections.set(active, section);
    }
    if (panel.firstElementChild !== section) {
      panel.replaceChildren(section);
      panel.scrollTop = 0;
      // Restart the entrance animation for the new section.
      panel.style.animation = "none";
      void panel.offsetWidth;
      panel.style.animation = "";
    }
  };
  refresh();
  store.on(["panel"], refresh);
  return element;
}
