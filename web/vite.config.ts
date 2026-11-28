import { defineConfig, type Plugin } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

/**
 * Preloads the regular reading serif: the CSS names it, but a browser only
 * fetches a font once text that uses it is laid out (after the bundle has
 * run), so the brand and the first reply would otherwise paint in the
 * fallback and swap. Same origin, so `font-src 'self'` covers it.
 */
function preloadSerif(): Plugin {
  return {
    name: "tomo-preload-serif",
    apply: "build",
    transformIndexHtml: { order: "post", handler(_html, ctx) {
      const font = Object.keys(ctx.bundle ?? {}).find((name) => /source-serif-4-latin-400-normal-[\w-]+\.woff2$/.test(name));
      return font ? [{ tag: "link", attrs: { rel: "preload", href: `/${font}`, as: "font", type: "font/woff2", crossorigin: "" }, injectTo: "head" }] : [];
    } },
  };
}

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [tailwindcss(), preloadSerif()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  build: {
    outDir: "../dist/web-assets", emptyOutDir: true, target: "es2022", sourcemap: false,
    // The Study, the screen window and the task view are lazy chunks. React
    // is its own chunk: its name (hash) survives app releases, so a browser
    // keeps it in cache (hashed assets are served immutable) across upgrades.
    // i18next and three.js are their own chunks for the same reason (a stable
    // vendor hash); the catalogs stay with the app. three.js (~550 kB) is the
    // largest chunk, lazy, loaded only with the home room on #home; the chat's
    // own chunk (with both languages' copy) is under 600 kB.
    chunkSizeWarningLimit: 600,
    rolldownOptions: {
      output: { codeSplitting: { groups: [{ name: "react", test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
        { name: "i18n", test: /node_modules[\\/](i18next|react-i18next|html-parse-stringify|void-elements)[\\/]/ },
        { name: "three", test: /node_modules[\\/]three[\\/]/ }] } },
      // Radix ships "use client" for React Server Components; meaningless in a client-only bundle.
      onwarn(warning, warn) { if (warning.code !== "MODULE_LEVEL_DIRECTIVE") warn(warning); },
    },
  },
});
