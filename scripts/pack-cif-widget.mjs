/**
 * Packs cif-external-widget/widget.html into cif-external-widget.zip
 * for upload to Zoho Creator as a standalone widget.
 * Usage: node scripts/pack-cif-widget.mjs
 */
import { createWriteStream, existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root      = join(__dirname, "..");

const SRC_HTML  = join(root, "cif-external-widget", "widget.html");
const PACK_DIR  = join(root, ".cif-widget-pack");
const OUT_ZIP   = join(root, "cif-external-widget.zip");

const MANIFEST  = {
  "type":    "widget",
  "version": "1.0.0",
  "name":    "CIF External",
  "resources": [{ "name": "index.html", "type": "html" }]
};

if (!existsSync(SRC_HTML)) {
  console.error("ERROR: cif-external-widget/widget.html not found — build it first.");
  process.exit(1);
}

// Create pack directory
if (!existsSync(PACK_DIR)) mkdirSync(PACK_DIR, { recursive: true });

// Copy widget HTML as index.html (Creator requires index.html)
copyFileSync(SRC_HTML, join(PACK_DIR, "index.html"));

// Write plugin manifest
writeFileSync(join(PACK_DIR, "plugin-manifest.json"), JSON.stringify(MANIFEST, null, 2));

// Zip using Node built-ins (no external deps)
const { createGzip } = await import("zlib");
const { pipeline }   = await import("stream/promises");

// Use a simple zip via archiver-like approach with native modules
// Falls back to PowerShell/zip command for simplicity
const { execSync } = await import("child_process");

try {
  // Try PowerShell Compress-Archive (Windows)
  execSync(
    `powershell -NoProfile -Command "Compress-Archive -Path '${join(PACK_DIR, "*")}' -DestinationPath '${OUT_ZIP}' -Force"`,
    { stdio: "inherit" }
  );
  console.log("✓ cif-external-widget.zip created at:", OUT_ZIP);
} catch (e) {
  // Fallback: zip command (Unix/Mac)
  try {
    execSync(`cd "${PACK_DIR}" && zip -r "${OUT_ZIP}" .`, { stdio: "inherit", shell: true });
    console.log("✓ cif-external-widget.zip created at:", OUT_ZIP);
  } catch (e2) {
    console.error("ERROR: Could not create zip. Please zip the contents of .cif-widget-pack/ manually.");
    process.exit(1);
  }
}
