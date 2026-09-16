import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  build: { outDir: "../dist/web-assets", emptyOutDir: true, target: "es2022", sourcemap: false },
});
