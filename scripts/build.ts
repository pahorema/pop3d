import { cp, mkdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";

const root = join(import.meta.dir, "..");
const dist = join(root, "dist");
const assets = join(dist, "assets");

/** Self-hosted variable fonts, copied from their npm packages. */
const FONTS = [
  "@fontsource-variable/geist/files/geist-latin-wght-normal.woff2",
  "@fontsource-variable/geist/files/geist-latin-ext-wght-normal.woff2",
  "@fontsource-variable/geist-mono/files/geist-mono-latin-wght-normal.woff2",
  "@fontsource-variable/fraunces/files/fraunces-latin-opsz-normal.woff2",
  "@fontsource-variable/fraunces/files/fraunces-latin-opsz-italic.woff2",
];

function fail(logs: unknown[]): never {
  for (const log of logs) console.error(String(log));
  throw new Error("Build failed");
}

export async function build({ dev = false } = {}): Promise<{ ms: number }> {
  const started = performance.now();
  await rm(dist, { recursive: true, force: true });
  await mkdir(assets, { recursive: true });
  await mkdir(join(dist, "fonts"), { recursive: true });
  await cp(join(root, "public"), dist, { recursive: true });
  await Promise.all(
    FONTS.map((font) => cp(join(root, "node_modules", font), join(dist, "fonts", basename(font)))),
  );

  const shared = {
    target: "browser",
    minify: !dev,
    sourcemap: dev ? "inline" : "none",
    define: { "process.env.NODE_ENV": JSON.stringify(dev ? "development" : "production") },
  } as const;

  // The geometry worker is bundled on its own (classic script, no shared chunks) so that it can
  // be started from a plain URL in every browser.
  const worker = await Bun.build({
    ...shared,
    entrypoints: [join(root, "src/worker/index.ts")],
    outdir: assets,
    format: "iife",
    naming: "worker-[hash].[ext]",
  });
  if (!worker.success) fail(worker.logs);
  const workerUrl = `/assets/${basename(worker.outputs[0]!.path)}`;

  const app = await Bun.build({
    ...shared,
    entrypoints: [join(root, "src/main.ts")],
    outdir: assets,
    format: "esm",
    splitting: true,
    external: ["/fonts/*"],
    naming: { entry: "[name]-[hash].[ext]", chunk: "[name]-[hash].[ext]", asset: "[name]-[hash].[ext]" },
    define: { ...shared.define, __WORKER_URL__: JSON.stringify(workerUrl), __DEV__: String(dev) },
  });
  if (!app.success) fail(app.logs);

  const entry = app.outputs.find((o) => o.kind === "entry-point" && o.path.endsWith(".js"));
  const styles = app.outputs.filter((o) => o.path.endsWith(".css"));
  if (!entry) throw new Error("Build produced no entry point");

  const tags = [
    ...styles.map((o) => `<link rel="stylesheet" href="/assets/${basename(o.path)}">`),
    `<script type="module" src="/assets/${basename(entry.path)}"></script>`,
    dev ? `<script>new EventSource("/__dev/reload").onmessage = () => location.reload();</script>` : "",
  ];
  const html = (await Bun.file(join(root, "src/index.html")).text()).replace(
    "<!--app-->",
    tags.join("\n    "),
  );
  await Bun.write(join(dist, "index.html"), html);

  return { ms: Math.round(performance.now() - started) };
}

if (import.meta.main) {
  const dev = process.argv.includes("--dev");
  const { ms } = await build({ dev });
  const glob = new Bun.Glob("**/*.{js,css,html}");
  const rows: string[] = [];
  for await (const file of glob.scan(dist)) {
    const bytes = Bun.file(join(dist, file)).size;
    const gz = Bun.gzipSync(new Uint8Array(await Bun.file(join(dist, file)).arrayBuffer())).length;
    rows.push(
      `  ${file.padEnd(34)} ${(bytes / 1024).toFixed(1).padStart(8)} kB  gzip ${(gz / 1024).toFixed(1).padStart(7)} kB`,
    );
  }
  console.log(`Built in ${ms} ms\n${rows.sort().join("\n")}`);
}
