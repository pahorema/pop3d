import { watch } from "node:fs";
import { join } from "node:path";
import { notifyReload, startServer } from "../server/index";
import { build } from "./build";

const root = join(import.meta.dir, "..");

async function rebuild(reason: string): Promise<void> {
  try {
    const { ms } = await build({ dev: true });
    console.log(`[dev] ${reason} -> built in ${ms} ms`);
    notifyReload();
  } catch (error) {
    console.error(`[dev] build failed: ${(error as Error).message}`);
  }
}

await rebuild("startup");
startServer();

let timer: ReturnType<typeof setTimeout> | undefined;
let running = Promise.resolve();
for (const dir of ["src", "shared", "public"]) {
  watch(join(root, dir), { recursive: true }, (_event, file) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      running = running.then(() => rebuild(String(file ?? dir)));
    }, 80);
  });
}
