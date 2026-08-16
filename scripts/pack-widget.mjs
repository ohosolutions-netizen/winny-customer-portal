// Packages the built single-file bundle into a Zoho Creator widget zip.
// Run after `npm run build`:  node scripts/pack-widget.mjs
import { mkdirSync, copyFileSync, existsSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(root, "dist/index.html");
if (!existsSync(dist)) {
  console.error("dist/index.html not found. Run `npm run build` first.");
  process.exit(1);
}

const pkgDir = resolve(root, ".widget-pack");
rmSync(pkgDir, { recursive: true, force: true });
mkdirSync(resolve(pkgDir, "widget"), { recursive: true });
copyFileSync(dist, resolve(pkgDir, "widget/index.html"));
copyFileSync(resolve(root, "plugin-manifest.json"), resolve(pkgDir, "plugin-manifest.json"));

const out = resolve(root, "winny-portal-widget.zip");
rmSync(out, { force: true });
execSync(`cd "${pkgDir}" && zip -r "${out}" plugin-manifest.json widget`, { stdio: "inherit" });
console.log("\nWidget package created:", out);
