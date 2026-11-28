import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import i18next from "eslint-plugin-i18next";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ["dist/", "node_modules/"],
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  // The two classic hook rules only. The plugin's v7 React Compiler rules
  // (refs, set-state-in-effect, purity, ...) are left off: the web UI does not
  // use the Compiler, and those rules mostly flag code it could not optimise.
  {
    files: ["web/src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  // The web UI's copy goes through its catalogs (web/src/i18n/). Mode "all":
  // every string literal and template in web/src, inside JSX or not, except
  // what cannot be copy: strings with no capital letter (class names, keys,
  // event names, CSS), file names, symbols, and the arguments and
  // properties listed below.
  {
    files: ["web/src/**/*.{ts,tsx}"],
    ignores: ["web/src/i18n/**"],
    plugins: { i18next },
    rules: {
      "i18next/no-literal-string": ["error", {
        mode: "all",
        "should-validate-template": true,
        "jsx-attributes": { include: ["title", "aria-label", "aria-description", "aria-valuetext", "aria-roledescription", "placeholder", "alt", "label", "what", "note", "aside", "heading", "top", "footer", "meta", "empty", "header"] },
        // Symbols, numbers and the brand are not copy.
        words: { exclude: ["[^A-Z]*", "[\\w.-]+\\.[a-z]{1,5}", "[0-9!-/:-@[-`{-~\\s·…→↓×−–—•]+", "[A-Z_-]+", "tomo", "Tomo", "OAuth"] },
        // Arguments that are options or class names, not copy.
        callees: { exclude: ["i18n(ext)?", "t", "require", "addEventListener", "removeEventListener", "getElementById", "includes", "indexOf", "endsWith", "startsWith",
          "cn", "cva", "toolIcon", "message", "channelLabel", "formatter", "Error", "Date", "Date.parse", "xhr.open", "formatNumber", "formatDate", "formatUnit", "formatRelative", "querySelector", "setAttribute", "useTranslation", "useResource", "api", "mutate"] },
        "object-properties": { exclude: ["[A-Z_-]+", "style", "dateStyle", "timeStyle", "role", "status", "state", "kind", "sessionId", "type", "behavior", "block", "unit", "unitDisplay", "notation", "currency", "currencyDisplay", "transform"] },
      }],
    },
  },
);
