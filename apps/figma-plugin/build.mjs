// Builds the Figma plugin into ./dist. The UI bundle is inlined into ui.html because Figma loads
// the UI as a single inlined document (__html__) — external script files are not fetched.
import { build } from "esbuild";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = import.meta.dirname;
const dist = resolve(root, "dist");
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

// Main thread: code.js (imports the figma-builder engine bundle). Figma's main-thread sandbox runs
// an older JS engine — down-level syntax (no optional chaining / nullish coalescing) via es2017.
await build({
  entryPoints: [resolve(root, "src/code.ts")],
  bundle: true,
  format: "iife",
  target: ["es2017"],
  outfile: resolve(dist, "code.js"),
  legalComments: "none",
});

// UI: bundle ui.ts, then inline it into the HTML template (runs in a Chromium iframe, but es2017
// keeps it consistent and safe).
const ui = await build({
  entryPoints: [resolve(root, "src/ui.ts")],
  bundle: true,
  format: "iife",
  target: ["es2017"],
  write: false,
  legalComments: "none",
});
const uiJs = ui.outputFiles[0].text;
const template = readFileSync(resolve(root, "src/ui.html"), "utf8");
writeFileSync(resolve(dist, "ui.html"), template.replace("/*__UI_BUNDLE__*/", () => uiJs));

copyFileSync(resolve(root, "src/manifest.json"), resolve(dist, "manifest.json"));

console.log("figma-plugin → apps/figma-plugin/dist (import manifest.json in Figma)");
