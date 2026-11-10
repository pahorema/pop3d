type Child = Node | string | number | null | undefined | false | Child[];

type Props = Record<string, unknown> | null;

function append(parent: Node, child: Child): void {
  if (child === null || child === undefined || child === false) return;
  if (Array.isArray(child)) for (const c of child) append(parent, c);
  else parent.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
}

/**
 * Tiny hyperscript helper. `class`, `html`, `style` and `data-*`/`aria-*` are set as expected;
 * `on<Event>` props become listeners; everything else is assigned as an attribute.
 */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Props,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === "class") element.className = String(value);
      else if (key === "html") element.innerHTML = String(value);
      else if (key.startsWith("on") && typeof value === "function") {
        element.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
      } else if (key in element && !key.startsWith("aria-") && !key.startsWith("data-") && key !== "list") {
        (element as unknown as Record<string, unknown>)[key] = value;
      } else element.setAttribute(key, value === true ? "" : String(value));
    }
  }
  for (const child of children) append(element, child);
  return element;
}

export function clear(element: Element): void {
  while (element.firstChild) element.firstChild.remove();
}

export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): (...args: A) => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args: A) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

/** Saves a blob under the given file name. */
export function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = h("a", { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
