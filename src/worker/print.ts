import type { PrintParams, PrintPart } from "../core/types";
import type { BuildState } from "./build";

/** Rebuilds the current model as watertight solids sized for a 3D printer. */
export function buildPrint(_state: BuildState, _params: PrintParams): { parts: PrintPart[]; scale: number } {
  return { parts: [], scale: 1 };
}
