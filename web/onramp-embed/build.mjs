// Builds dist/v1/: index.html + one content-hashed bundle with the SDK
// inlined (bundled and version-pinned, never a runtime CDN load, §4.3).
// Paths are versioned and immutable so installed apps keep working while
// a newer page ships; the app reads the page URL from GET /onramp/config.
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, "dist", "v1");

const result = await build({
  entryPoints: [path.join(here, "main.ts")],
  bundle: true,
  minify: true,
  format: "iife",
  target: ["es2020", "safari14", "chrome90"],
  platform: "browser",
  write: false,
  legalComments: "none",
  // Resolve the kit from this project first, so a CI that installs only
  // web/onramp-embed builds the same pinned version.
  nodePaths: [path.join(here, "node_modules")],
  define: { "process.env.NODE_ENV": '"production"' },
});

const js = result.outputFiles[0].contents;
const hash = createHash("sha256").update(js).digest("hex").slice(0, 16);
const bundleName = `onramp.${hash}.js`;

await rm(path.join(here, "dist"), { recursive: true, force: true });
await mkdir(out, { recursive: true });
await writeFile(path.join(out, bundleName), js);
const html = await readFile(path.join(here, "index.html"), "utf8");
await writeFile(
  path.join(out, "index.html"),
  html.replace("./__BUNDLE__", `./${bundleName}`),
);
await writeFile(
  path.join(here, "dist", "_headers"),
  await readFile(path.join(here, "_headers"), "utf8"),
);
console.log(`built dist/v1/${bundleName} (${js.length} bytes)`);
