import { h } from "./dom";
import { type IconName, icons } from "./icons";

export function icon(name: IconName, className = "icon"): HTMLSpanElement {
  return h("span", { class: className, html: icons[name] });
}

export function iconButton(
  name: IconName,
  label: string,
  onClick: (event: MouseEvent) => void,
  className = "",
): HTMLButtonElement {
  return h("button", {
    class: `icon-button ${className}`.trim(),
    type: "button",
    title: label,
    "aria-label": label,
    html: icons[name],
    onclick: onClick,
  });
}

export function section(title: string | null, ...children: (Node | null)[]): HTMLElement {
  return h("section", { class: "group" }, title ? h("h3", { class: "group-title" }, title) : null, children);
}

export interface SliderOptions {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  format: (value: number) => string;
  /** Fires continuously while dragging. */
  onInput?: (value: number) => void;
  /** Fires once when the value is committed. */
  onChange?: (value: number) => void;
  /** Maps the linear slider position to the value, for non-linear scales. */
  scale?: { toValue(position: number): number; toPosition(value: number): number };
  hints?: [string, string];
}

export interface SliderHandle {
  element: HTMLElement;
  set(value: number): void;
  setDisabled(disabled: boolean): void;
}

export function slider(options: SliderOptions): SliderHandle {
  const { scale } = options;
  const toPosition = (value: number) => (scale ? scale.toPosition(value) : value);
  const toValue = (position: number) => (scale ? scale.toValue(position) : position);
  const output = h("output", { class: "slider-value" }, options.format(options.value));
  const input = h("input", {
    type: "range",
    class: "slider-input",
    min: scale ? 0 : options.min,
    max: scale ? 1000 : options.max,
    step: scale ? 1 : options.step,
    "aria-label": options.label,
  });
  const paint = () => {
    const min = Number(input.min);
    const max = Number(input.max);
    input.style.setProperty("--fill", `${((Number(input.value) - min) / (max - min)) * 100}%`);
  };
  const set = (value: number) => {
    input.value = String(toPosition(value));
    output.textContent = options.format(value);
    paint();
  };
  set(options.value);
  input.addEventListener("input", () => {
    const value = toValue(Number(input.value));
    output.textContent = options.format(value);
    paint();
    options.onInput?.(value);
  });
  input.addEventListener("change", () => options.onChange?.(toValue(Number(input.value))));
  const element = h(
    "label",
    { class: "slider" },
    h("span", { class: "slider-head" }, h("span", { class: "slider-label" }, options.label), output),
    input,
    options.hints
      ? h(
          "span",
          { class: "slider-hints" },
          h("span", null, options.hints[0]),
          h("span", null, options.hints[1]),
        )
      : null,
  );
  return {
    element,
    set,
    setDisabled(disabled) {
      input.disabled = disabled;
      element.classList.toggle("is-disabled", disabled);
    },
  };
}

export interface ToggleHandle {
  element: HTMLElement;
  set(value: boolean): void;
}

export function toggle(
  label: string,
  hint: string | null,
  value: boolean,
  onChange: (value: boolean) => void,
): ToggleHandle {
  const input = h("input", { type: "checkbox", class: "toggle-input", checked: value });
  input.addEventListener("change", () => onChange(input.checked));
  const element = h(
    "label",
    { class: "toggle" },
    h(
      "span",
      { class: "toggle-text" },
      h("span", { class: "toggle-label" }, label),
      hint ? h("span", { class: "toggle-hint" }, hint) : null,
    ),
    input,
    h("span", { class: "toggle-track" }, h("span", { class: "toggle-thumb" })),
  );
  return {
    element,
    set(next) {
      input.checked = next;
    },
  };
}

export interface SegmentedHandle<T> {
  element: HTMLElement;
  set(value: T): void;
}

export function segmented<T extends string | number>(
  label: string,
  options: { value: T; label: string; icon?: IconName }[],
  value: T,
  onChange: (value: T) => void,
): SegmentedHandle<T> {
  const buttons = new Map<T, HTMLButtonElement>();
  const element = h("div", { class: "segmented", role: "radiogroup", "aria-label": label });
  const set = (next: T) => {
    for (const [key, button] of buttons) {
      const active = key === next;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-checked", String(active));
    }
  };
  for (const option of options) {
    const button = h(
      "button",
      {
        type: "button",
        class: "segment",
        role: "radio",
        title: option.icon ? option.label : null,
        "aria-label": option.icon ? option.label : null,
        onclick: () => {
          set(option.value);
          onChange(option.value);
        },
      },
      option.icon ? icon(option.icon) : option.label,
    );
    buttons.set(option.value, button);
    element.append(button);
  }
  set(value);
  return { element, set };
}

export function button(
  label: string,
  onClick: () => void,
  options: { icon?: IconName; variant?: "primary" | "ghost" | "soft"; className?: string } = {},
): HTMLButtonElement {
  return h(
    "button",
    {
      type: "button",
      class: `button button-${options.variant ?? "soft"} ${options.className ?? ""}`.trim(),
      onclick: onClick,
    },
    options.icon ? icon(options.icon) : null,
    h("span", { class: "button-label" }, label),
  );
}
