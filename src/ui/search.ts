import type { Place } from "../../shared/types";
import { reverseGeocode, searchPlaces, suggestPlaces } from "../core/api";
import { t } from "../core/i18n";
import type { Store } from "../core/store";
import { formatCoordinates, parseCoordinates } from "../geo/coords";
import { icon, iconButton } from "./controls";
import { clear, debounce, h } from "./dom";
import type { IconName } from "./icons";

export interface PickedPlace {
  lat: number;
  lon: number;
  name: string;
  detail: string;
  /** Suggested extent in metres, for curated examples. */
  span?: number;
  relief?: number;
}

/** Places that show off what the generator can do. */
const EXAMPLES: PickedPlace[] = [
  { name: "Piazza Unità d'Italia", detail: "Trieste, Italia", lat: 45.6503, lon: 13.7678, span: 800 },
  { name: "Ponte di Rialto", detail: "Venezia, Italia", lat: 45.438, lon: 12.3359, span: 700 },
  { name: "Duomo di Firenze", detail: "Firenze, Italia", lat: 43.7731, lon: 11.256, span: 650 },
  { name: "Vernazza", detail: "Cinque Terre, Italia", lat: 44.1349, lon: 9.6838, span: 800, relief: 1.2 },
  {
    name: "Mont-Saint-Michel",
    detail: "Normandie, France",
    lat: 48.636,
    lon: -1.5114,
    span: 700,
    relief: 1.5,
  },
  { name: "Île de la Cité", detail: "Paris, France", lat: 48.8548, lon: 2.3475, span: 1100 },
  { name: "Empire State Building", detail: "Manhattan, New York", lat: 40.7484, lon: -73.9857, span: 900 },
  {
    name: "Hallstatt",
    detail: "Salzkammergut, Österreich",
    lat: 47.5613,
    lon: 13.6493,
    span: 1000,
    relief: 1,
  },
  { name: "Cervino · Matterhorn", detail: "Alpi Pennine", lat: 45.9766, lon: 7.6585, span: 4000, relief: 1 },
];

function iconFor(kind: string): IconName {
  if (/house|building|address|amenity|shop|tourism/.test(kind)) return "building";
  if (/city|town|village|country|state|county|district|locality|suburb|postcode/.test(kind)) return "globe";
  return "pin";
}

export function createSearch(
  store: Store,
  onPick: (place: PickedPlace) => void,
  notify: (message: string) => void,
): { element: HTMLElement; focus(): void } {
  let items: PickedPlace[] = [];
  let active = -1;
  let request: AbortController | null = null;
  let open = false;

  const input = h("input", {
    class: "search-input",
    type: "search",
    placeholder: t("search.placeholder"),
    autocomplete: "off",
    autocapitalize: "off",
    spellcheck: false,
    enterKeyHint: "search",
    "aria-label": t("search.placeholder"),
  });
  const busy = h("span", { class: "spinner", hidden: true });
  const clearButton = iconButton("close", t("search.clear"), () => {
    input.value = "";
    element.classList.remove("has-text");
    clearButton.hidden = true;
    input.focus();
    showExamples();
  });
  clearButton.hidden = true;
  const results = h("div", { class: "search-results", role: "listbox", hidden: true });
  const element = h(
    "div",
    { class: "search" },
    h(
      "div",
      { class: "search-box card" },
      icon("search"),
      input,
      busy,
      h("kbd", { class: "search-key" }, "/"),
      clearButton,
      iconButton("locate", t("search.locate"), locate),
    ),
    results,
  );

  function setOpen(next: boolean): void {
    open = next;
    results.hidden = !next;
    element.classList.toggle("is-open", next);
  }

  function render(heading: string, message?: string): void {
    clear(results);
    active = -1;
    if (message) {
      results.append(h("div", { class: "search-empty" }, message));
      setOpen(true);
      return;
    }
    if (!items.length) {
      setOpen(false);
      return;
    }
    results.append(h("div", { class: "search-heading" }, heading));
    items.forEach((item, index) => {
      results.append(
        h(
          "button",
          {
            class: "search-item",
            type: "button",
            role: "option",
            // Keep focus in the input so that blur does not close the list before the click lands.
            onpointerdown: (event: Event) => event.preventDefault(),
            onclick: () => pick(index),
            onpointermove: () => setActive(index),
          },
          icon(item.span ? "pin" : iconFor((item as PickedPlace & { kind?: string }).kind ?? "")),
          h(
            "span",
            { class: "search-text" },
            h("span", { class: "search-name" }, item.name),
            item.detail ? h("span", { class: "search-detail" }, item.detail) : null,
          ),
        ),
      );
    });
    setOpen(true);
  }

  function setActive(index: number): void {
    if (index === active) return;
    active = index;
    results.querySelectorAll(".search-item").forEach((node, i) => {
      node.classList.toggle("is-active", i === active);
      if (i === active) node.scrollIntoView({ block: "nearest" });
    });
  }

  function showExamples(): void {
    request?.abort();
    busy.hidden = true;
    items = EXAMPLES;
    render(t("search.examples"));
  }

  function pick(index: number): void {
    const item = items[index];
    if (!item) return;
    input.value = item.name;
    element.classList.add("has-text");
    clearButton.hidden = false;
    setOpen(false);
    input.blur();
    onPick(item);
  }

  const fromPlace = (place: Place): PickedPlace & { kind: string } => ({
    lat: place.lat,
    lon: place.lon,
    name: place.name,
    detail: place.detail,
    kind: place.kind,
  });

  async function lookup(text: string, full: boolean): Promise<void> {
    request?.abort();
    const controller = new AbortController();
    request = controller;
    busy.hidden = false;
    try {
      const { area } = store.state;
      const places = full
        ? await searchPlaces(text, controller.signal)
        : await suggestPlaces(text, area, controller.signal);
      if (controller.signal.aborted) return;
      items = places.map(fromPlace);
      if (full && items.length === 1) {
        pick(0);
        return;
      }
      if (items.length) render(t("search.results"));
      else if (full) render("", t("search.none"));
      else setOpen(false);
    } catch (error) {
      if ((error as Error).name === "AbortError") return;
      render("", t("search.error"));
    } finally {
      if (request === controller) busy.hidden = true;
    }
  }

  const suggest = debounce((text: string) => void lookup(text, false), 260);

  function onInput(): void {
    const text = input.value.trim();
    element.classList.toggle("has-text", text.length > 0);
    clearButton.hidden = text.length === 0;
    if (!text) {
      showExamples();
      return;
    }
    const coordinates = parseCoordinates(text);
    if (coordinates) {
      request?.abort();
      busy.hidden = true;
      items = [{ ...coordinates, name: formatCoordinates(coordinates, 5), detail: t("search.coordinates") }];
      render(t("search.results"));
      setActive(0);
      return;
    }
    if (text.length >= 3) suggest(text);
  }

  function locate(): void {
    if (!navigator.geolocation) {
      notify(t("search.locateDenied"));
      return;
    }
    busy.hidden = false;
    navigator.geolocation.getCurrentPosition(
      async ({ coords }) => {
        const place = await reverseGeocode(coords.latitude, coords.longitude);
        busy.hidden = true;
        const here = { lat: coords.latitude, lon: coords.longitude };
        onPick({ ...here, name: place?.name ?? formatCoordinates(here), detail: place?.detail ?? "" });
      },
      () => {
        busy.hidden = true;
        notify(t("search.locateDenied"));
      },
      { enableHighAccuracy: true, timeout: 12_000, maximumAge: 60_000 },
    );
  }

  input.addEventListener("input", onInput);
  input.addEventListener("focus", () => {
    if (!input.value.trim()) showExamples();
    else if (items.length) setOpen(true);
    input.select();
  });
  input.addEventListener("blur", () => setOpen(false));
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open || !items.length) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((active + step + items.length) % items.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const text = input.value.trim();
      if (open && active >= 0) pick(active);
      else if (text) void lookup(text, true);
    } else if (event.key === "Escape") {
      if (open) setOpen(false);
      else input.blur();
    }
    event.stopPropagation();
  });

  return { element, focus: () => input.focus() };
}
