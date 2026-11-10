import { Engine } from "./core/engine";
import type { BuildParams } from "./core/types";
import { Diorama } from "./scene/diorama";
import { findTheme } from "./scene/themes";
import { Viewer } from "./scene/viewer";

const app = document.querySelector<HTMLElement>("#app")!;
app.style.cssText = "position:fixed;inset:0";
const query = new URLSearchParams(location.search);
const theme = findTheme(query.get("t") ?? "diorama");

const viewer = new Viewer(app, {
  shadows: true,
  shadowSoftness: 2.5,
  ambientOcclusion: true,
  miniature: Number(query.get("m") ?? 0.5),
  sunAzimuth: 135,
  sunElevation: 42,
  autoRotate: false,
});
viewer.setTheme(theme);

const [lat, lon] = (query.get("c") ?? "45.6503,13.7678").split(",").map(Number) as [number, number];
const size = Number(query.get("s") ?? 700);
const params: BuildParams = {
  area: { lat, lon, shape: (query.get("shape") as any) ?? "circle", width: size, depth: size },
  detail: Number(query.get("d") ?? 1) as 0 | 1 | 2,
  relief: Number(query.get("r") ?? 1),
  roofs: true,
};

const engine = new Engine();
const data = await engine.build(params, (stage, ratio) => console.log(stage, ratio));
console.log(data.stats);
const diorama = new Diorama(data, { theme, buildingColors: "theme", edges: false, faceted: false });
viewer.setDiorama(diorama, { animate: true, keepView: false });
Object.assign(window, { viewer, diorama });
