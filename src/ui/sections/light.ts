import { formatNumber, type MessageKey, t } from "../../core/i18n";
import type { Store } from "../../core/store";
import type { ViewSettings } from "../../scene/viewer";
import { section, slider, toggle } from "../controls";
import { h } from "../dom";

const PRESETS: { id: string; azimuth: number; elevation: number }[] = [
  { id: "dawn", azimuth: 82, elevation: 9 },
  { id: "morning", azimuth: 112, elevation: 30 },
  { id: "noon", azimuth: 178, elevation: 64 },
  { id: "afternoon", azimuth: 238, elevation: 36 },
  { id: "sunset", azimuth: 282, elevation: 9 },
];

const COMPASS = ["N", "NE", "E", "SE", "S", "SO", "O", "NO"];
const COMPASS_EN = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

export function createLightSection(store: Store): HTMLElement {
  const setView = (patch: Partial<ViewSettings>) => store.set({ view: { ...store.state.view, ...patch } });
  const bearing = (degrees: number) => {
    const names = store.state.lang === "it" ? COMPASS : COMPASS_EN;
    return `${names[Math.round(degrees / 45) % 8]} ${Math.round(degrees)}°`;
  };

  // The dial is the sky seen from above: the rim is the horizon, the centre is straight up.
  const sun = h("span", { class: "sundial-sun" });
  const shadow = h("span", { class: "sundial-shadow" });
  const dial = h(
    "div",
    { class: "sundial-dial", role: "img", "aria-label": t("light.sun") },
    h("span", { class: "sundial-north" }, "N"),
    shadow,
    h("span", { class: "sundial-block" }),
    sun,
  );
  const fromPointer = (event: PointerEvent): void => {
    const rect = dial.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width - 0.5;
    const y = (event.clientY - rect.top) / rect.height - 0.5;
    const distance = Math.min(1, Math.hypot(x, y) / 0.44);
    const azimuth = ((Math.atan2(x, -y) * 180) / Math.PI + 360) % 360;
    setView({ sunAzimuth: Math.round(azimuth), sunElevation: Math.round(Math.max(4, 90 - distance * 86)) });
  };
  dial.addEventListener("pointerdown", (event) => {
    dial.setPointerCapture(event.pointerId);
    fromPointer(event);
  });
  dial.addEventListener("pointermove", (event) => {
    if (dial.hasPointerCapture(event.pointerId)) fromPointer(event);
  });

  const azimuth = slider({
    label: t("light.azimuth"),
    min: 0,
    max: 359,
    step: 1,
    value: store.state.view.sunAzimuth,
    format: bearing,
    onInput: (value) => setView({ sunAzimuth: value }),
  });
  const elevation = slider({
    label: t("light.elevation"),
    min: 4,
    max: 88,
    step: 1,
    value: store.state.view.sunElevation,
    format: (value) => `${Math.round(value)}°`,
    onInput: (value) => setView({ sunElevation: value }),
  });

  const chips = h("div", { class: "chips" });
  const presetButtons = PRESETS.map((preset) => {
    const chip = h(
      "button",
      {
        class: "chip",
        type: "button",
        onclick: () => setView({ sunAzimuth: preset.azimuth, sunElevation: preset.elevation }),
      },
      t(`light.preset.${preset.id}` as MessageKey),
    );
    chips.append(chip);
    return chip;
  });

  const shadows = toggle(t("light.shadows"), null, store.state.view.shadows, (value) =>
    setView({ shadows: value }),
  );
  const softness = slider({
    label: t("light.softness"),
    min: 0.5,
    max: 8,
    step: 0.5,
    value: store.state.view.shadowSoftness,
    format: (value) => formatNumber(value, 1),
    onInput: (value) => setView({ shadowSoftness: value }),
  });
  const occlusion = toggle(t("light.ao"), t("light.ao.hint"), store.state.view.ambientOcclusion, (value) =>
    setView({ ambientOcclusion: value }),
  );
  const miniature = slider({
    label: t("light.miniature"),
    min: 0,
    max: 1,
    step: 0.05,
    value: store.state.view.miniature,
    format: (value) => `${Math.round(value * 100)}%`,
    onInput: (value) => setView({ miniature: value }),
  });
  const rotate = toggle(t("light.rotate"), null, store.state.view.autoRotate, (value) =>
    setView({ autoRotate: value }),
  );

  const refresh = (): void => {
    const { view } = store.state;
    const angle = (view.sunAzimuth * Math.PI) / 180;
    const distance = ((90 - view.sunElevation) / 86) * 44;
    sun.style.transform = `translate(${Math.sin(angle) * distance}px, ${-Math.cos(angle) * distance}px)`;
    // The shadow points away from the sun and stretches as the sun sinks.
    const length = Math.min(40, 8 / Math.tan((Math.max(6, view.sunElevation) * Math.PI) / 180));
    shadow.style.height = `${7 + length}px`;
    shadow.style.transform = `rotate(${view.sunAzimuth}deg)`;
    azimuth.set(view.sunAzimuth);
    elevation.set(view.sunElevation);
    shadows.set(view.shadows);
    softness.set(view.shadowSoftness);
    softness.setDisabled(!view.shadows);
    occlusion.set(view.ambientOcclusion);
    miniature.set(view.miniature);
    rotate.set(view.autoRotate);
    PRESETS.forEach((preset, index) => {
      presetButtons[index]!.classList.toggle(
        "is-active",
        preset.azimuth === view.sunAzimuth && preset.elevation === view.sunElevation,
      );
    });
  };
  refresh();
  store.on(["view"], refresh);

  return h(
    "div",
    null,
    section(
      t("light.sun"),
      h(
        "div",
        { class: "sundial" },
        dial,
        h("div", { style: "display:grid;gap:12px" }, azimuth.element, elevation.element),
      ),
      chips,
    ),
    section(t("light.shadows"), shadows.element, softness.element),
    section(t("light.effects"), occlusion.element, miniature.element, rotate.element),
  );
}
