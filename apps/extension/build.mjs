// Builds the Chrome MV3 extension into ./dist (load-unpacked target).
import { build } from "esbuild";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const root = import.meta.dirname;
const dist = resolve(root, "dist");
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

await build({
  entryPoints: {
    content: resolve(root, "src/content.ts"),
    background: resolve(root, "src/background.ts"),
    popup: resolve(root, "src/popup.ts"),
  },
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "chrome120",
  outdir: dist,
  legalComments: "none",
});

copyFileSync(resolve(root, "src/manifest.json"), resolve(dist, "manifest.json"));
copyFileSync(resolve(root, "src/popup.html"), resolve(dist, "popup.html"));

console.log("extension → apps/extension/dist (load unpacked)");
