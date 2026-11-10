import "./styles/main.css";
import { App } from "./app";
import { detectLanguage, setLanguage, t } from "./core/i18n";
import { defaultState, loadPreferences, readUrl, Store } from "./core/store";
import { h } from "./ui/dom";

const root = document.querySelector<HTMLElement>("#app")!;
const lang = detectLanguage();
setLanguage(lang);

function supportsWebGl2(): boolean {
  try {
    return Boolean(document.createElement("canvas").getContext("webgl2"));
  } catch {
    return false;
  }
}

if (!supportsWebGl2()) {
  root.append(h("div", { class: "fatal" }, h("h1", null, "pop3d"), h("p", null, t("error.webgl"))));
} else {
  const { state } = readUrl(loadPreferences(defaultState(lang)), location.search);
  const app = new App(root, new Store(state));
  void app.generate();
  if (__DEV__) Object.assign(window, { app });
}

declare const __DEV__: boolean;
