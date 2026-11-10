import { formatDistance, formatNumber, type MessageKey, t } from "../core/i18n";
import type { AppState, PlaceLabel } from "../core/store";
import type { BuildingInfo, BuildStage, DioramaData } from "../core/types";
import { formatCoordinates } from "../geo/coords";
import { button, icon, iconButton } from "./controls";
import { clear, h } from "./dom";
import { logoMark } from "./icons";

// ---- Brand -----------------------------------------------------------------------------------

export function createBrand(): HTMLElement {
  return h(
    "a",
    { class: "brand card", href: "/", title: t("app.tagline"), "aria-label": "pop3d" },
    h("span", { class: "icon", html: logoMark }),
    h("span", { class: "brand-name", html: "pop<em>3d</em>" }),
  );
}

// ---- Caption ---------------------------------------------------------------------------------

export interface Caption {
  element: HTMLElement;
  setPlace(place: PlaceLabel | null, loading: boolean): void;
  setData(state: AppState, data: DioramaData): void;
}

/** The label of the model, like the plate under a museum exhibit. */
export function createCaption(onLanguage: () => void): Caption {
  const title = h("h1", { class: "caption-title" });
  const detail = h("div", { class: "caption-detail" });
  const meta = h("div", { class: "caption-meta" });
  const stats = h("div", { class: "caption-stats" });
  const credits = h(
    "div",
    { class: "caption-credits" },
    h(
      "a",
      { href: "https://www.openstreetmap.org/copyright", target: "_blank", rel: "noopener" },
      t("credits.osm"),
    ),
    " · ",
    h(
      "a",
      {
        href: "https://github.com/tilezen/joerd/blob/master/docs/attribution.md",
        target: "_blank",
        rel: "noopener",
      },
      t("credits.terrain"),
    ),
    " · ",
    h("a", { href: "https://github.com/pahorema/pop3d", target: "_blank", rel: "noopener" }, "GitHub"),
    " · ",
    h(
      "a",
      {
        href: "#",
        onclick: (event: Event) => {
          event.preventDefault();
          onLanguage();
        },
      },
      t("lang.switch"),
    ),
  );
  const element = h("div", { class: "caption card is-loading" }, title, detail, meta, stats, credits);

  return {
    element,
    setPlace(place, loading) {
      element.classList.toggle("is-loading", loading && !place);
      title.textContent = place?.name ?? t("caption.loading");
      detail.textContent = place?.detail ?? "";
      detail.hidden = !loading && !place?.detail;
    },
    setData(state, data) {
      const { area } = data.params;
      const size =
        area.width === area.depth
          ? `${area.shape === "circle" ? "⌀" : "□"} ${formatDistance(area.width)}`
          : `${formatDistance(area.width)} × ${formatDistance(area.depth)}`;
      clear(meta);
      meta.append(h("span", null, formatCoordinates(area)), h("span", null, size));
      clear(stats);
      const { stats: s } = data;
      const parts: string[] = [];
      if (s.buildings) parts.push(t("stats.buildings", { n: formatNumber(s.buildings) }));
      if (s.trees) parts.push(t("stats.trees", { n: formatNumber(s.trees) }));
      if (s.roadKm >= 0.1) parts.push(t("stats.roads", { n: formatNumber(s.roadKm, 1) }));
      if (data.params.relief > 0 && (s.elevation[0] !== 0 || s.elevation[1] !== 0)) {
        parts.push(
          t("stats.elevation", {
            min: formatNumber(Math.round(s.elevation[0])),
            max: formatNumber(Math.round(s.elevation[1])),
          }),
        );
      }
      for (const part of parts) stats.append(h("span", null, part));
      if (s.osmTimestamp) {
        const date = new Date(s.osmTimestamp);
        if (!Number.isNaN(date.getTime())) {
          element.title = t("stats.data", {
            date: date.toLocaleDateString(state.lang === "it" ? "it-IT" : "en-GB", { dateStyle: "long" }),
          });
        }
      }
    },
  };
}

// ---- View bar --------------------------------------------------------------------------------

export interface ViewBarActions {
  zoom(factor: number): void;
  home(): void;
  top(): void;
  north(): void;
  toggleRotate(): void;
  fullscreen(): void;
  hideUi(): void;
}

export interface ViewBar {
  element: HTMLElement;
  setHeading(radians: number): void;
  setRotating(on: boolean): void;
}

export function createViewBar(actions: ViewBarActions): ViewBar {
  const needle = h("span", {
    html: `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M12 2.5 15.2 12H8.8L12 2.5Z" fill="var(--accent)"/><path d="M12 21.5 8.8 12h6.4L12 21.5Z" fill="var(--ink-faint)" opacity=".55"/><circle cx="12" cy="12" r="1.3" fill="var(--surface-solid)"/></svg>`,
  });
  const compass = h(
    "button",
    {
      class: "compass",
      type: "button",
      title: t("view.north"),
      "aria-label": t("view.north"),
      onclick: actions.north,
    },
    needle,
  );
  const rotate = iconButton("rotate", t("view.rotate"), actions.toggleRotate);
  const fullscreen = iconButton("fullscreen", t("view.fullscreen"), actions.fullscreen, "optional");
  const hide = iconButton("hide", t("view.hideUi"), actions.hideUi, "optional");
  const element = h(
    "div",
    { class: "viewbar card", role: "toolbar" },
    compass,
    h("hr"),
    iconButton("plus", t("view.zoomIn"), () => actions.zoom(0.62)),
    iconButton("minus", t("view.zoomOut"), () => actions.zoom(1.6)),
    h("hr"),
    iconButton("home", t("view.home"), actions.home),
    iconButton("top", t("view.top"), actions.top),
    rotate,
    h("hr", { class: "optional" }),
    fullscreen,
    hide,
  );
  const svg = needle.firstElementChild as SVGElement;
  let last = Number.NaN;
  return {
    element,
    setHeading(radians) {
      const degrees = Math.round((radians * 180) / Math.PI);
      if (degrees === last) return;
      last = degrees;
      svg.style.transform = `rotate(${degrees}deg)`;
    },
    setRotating(on) {
      rotate.classList.toggle("is-active", on);
    },
  };
}

// ---- Progress and toasts ---------------------------------------------------------------------

export interface Status {
  element: HTMLElement;
  progress(stage: BuildStage, ratio: number): void;
  finish(): void;
  toast(message: string, action?: { label: string; run(): void }, duration?: number): void;
}

export function createStatus(): Status {
  const element = h("div", { class: "status", "aria-live": "polite" });
  let bar: { root: HTMLElement; label: HTMLElement; fill: HTMLElement } | null = null;
  let slowTimer: ReturnType<typeof setTimeout> | undefined;
  let stage: BuildStage | null = null;

  const STAGE_LABEL: Record<BuildStage, MessageKey> = {
    osm: "progress.osm",
    terrain: "progress.terrain",
    geometry: "progress.geometry",
  };

  return {
    element,
    progress(next, ratio) {
      if (!bar) {
        const label = h("span");
        const fill = h("div", { class: "progress-fill" });
        const root = h(
          "div",
          { class: "progress card" },
          h("span", { class: "spinner" }),
          label,
          h("div", { class: "progress-bar" }, fill),
        );
        bar = { root, label, fill };
        element.prepend(root);
      }
      if (next !== stage) {
        stage = next;
        clearTimeout(slowTimer);
        bar.label.textContent = `${t(STAGE_LABEL[next])}…`;
        if (next === "osm") {
          slowTimer = setTimeout(() => {
            if (bar && stage === "osm") bar.label.textContent = `${t("progress.slow")}…`;
          }, 9000);
        }
      }
      const determinate = next === "geometry";
      bar.root.classList.toggle("is-indeterminate", !determinate);
      bar.fill.style.width = determinate ? `${Math.round(8 + ratio * 92)}%` : "";
    },
    finish() {
      clearTimeout(slowTimer);
      stage = null;
      bar?.root.remove();
      bar = null;
    },
    toast(message, action, duration = 5200) {
      const node = h("div", { class: "toast", role: "status" }, h("span", null, message));
      const dismiss = () => {
        node.classList.add("is-leaving");
        setTimeout(() => node.remove(), 320);
      };
      if (action) {
        node.append(
          h(
            "button",
            {
              type: "button",
              onclick: () => {
                dismiss();
                action.run();
              },
            },
            action.label,
          ),
        );
      }
      element.append(node);
      setTimeout(dismiss, action ? Math.max(duration, 9000) : duration);
    },
  };
}

// ---- Building inspector ----------------------------------------------------------------------

export interface Inspector {
  element: HTMLElement;
  show(info: BuildingInfo): void;
  hide(): void;
}

export function createInspector(actions: { close(): void; hideBuilding(): void }): Inspector {
  const element = h("div", { class: "inspector card", hidden: true });
  return {
    element,
    show(info) {
      clear(element);
      const kind = info.kind && info.kind !== "yes" ? info.kind.replace(/_/g, " ") : t("inspect.building");
      const facts = h("dl", { class: "inspector-facts" });
      facts.append(
        h("dt", null, t("inspect.height")),
        h(
          "dd",
          null,
          `${formatNumber(info.height, 1)} m${info.measured ? "" : ` · ${t("inspect.estimated")}`}`,
        ),
      );
      if (info.levels) facts.append(h("dt", null, t("inspect.levels")), h("dd", null, String(info.levels)));
      element.append(
        h(
          "div",
          { class: "inspector-head" },
          h(
            "div",
            { style: "flex:1;min-width:0" },
            h("h2", { class: "inspector-title" }, info.name ?? info.address ?? t("inspect.building")),
            h(
              "div",
              { class: "inspector-kind" },
              info.name && info.address ? `${kind} · ${info.address}` : kind,
            ),
          ),
          iconButton("close", t("panel.close"), actions.close),
        ),
        facts,
        h(
          "div",
          { class: "button-row" },
          button(t("inspect.hide"), actions.hideBuilding, { icon: "eyeOff" }),
          info.id
            ? h(
                "a",
                {
                  class: "button button-ghost",
                  href: `https://www.openstreetmap.org/${info.relation ? "relation" : "way"}/${info.id}`,
                  target: "_blank",
                  rel: "noopener",
                  title: t("inspect.osm"),
                },
                icon("link"),
                h("span", { class: "button-label" }, "OSM"),
              )
            : null,
        ),
      );
      element.hidden = false;
    },
    hide() {
      element.hidden = true;
    },
  };
}
