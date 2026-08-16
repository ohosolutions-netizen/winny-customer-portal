import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";

// Zoho Creator widgets are served as a self-contained bundle from inside an
// iframe. We inline the JS/CSS into a single index.html so the whole widget is
// one static file that Creator can host. The two Zoho SDK <script> tags in
// index.html stay external (loaded from Zoho's CDN) exactly as the original.
export default defineConfig({
  base: "./",
  plugins: [react(), viteSingleFile()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    assetsInlineLimit: 100000000,
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
});
