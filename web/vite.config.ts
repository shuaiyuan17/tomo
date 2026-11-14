import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  build: {
    outDir: "../dist/web-assets", emptyOutDir: true, target: "es2022", sourcemap: false,
    // One local bundle served from loopback; Radix brings it past the 500 kB default.
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      // Radix ships "use client" for React Server Components; meaningless in a client-only bundle.
      onwarn(warning, warn) { if (warning.code !== "MODULE_LEVEL_DIRECTIVE") warn(warning); },
    },
  },
});
