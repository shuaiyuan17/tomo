import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import i18next from "eslint-plugin-i18next";

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
  // The web UI's copy goes through its catalogs (web/src/i18n/): no literal
  // text in JSX, nor in the attributes a person reads or hears.
  {
    files: ["web/src/**/*.tsx"],
    ignores: ["web/src/i18n/**"],
    plugins: { i18next },
    rules: {
      "i18next/no-literal-string": ["error", {
        mode: "jsx-only",
        "should-validate-template": true,
        "jsx-attributes": { include: ["title", "aria-label", "aria-description", "aria-valuetext", "aria-roledescription", "placeholder", "alt", "label", "what", "note", "aside", "heading", "top", "footer", "meta", "empty", "header"] },
        // Symbols, numbers and the brand are not copy.
        words: { exclude: ["[0-9!-/:-@[-`{-~\\s·…→↓×−–—•]+", "[A-Z_-]+", "tomo", "Tomo", "OAuth"] },
        // Arguments that are options or class names, not copy.
        callees: { exclude: ["i18n(ext)?", "t", "require", "addEventListener", "removeEventListener", "getElementById", "includes", "indexOf", "endsWith", "startsWith",
          "cn", "channelLabel", "formatNumber", "formatDate", "formatUnit", "formatRelative", "querySelector", "setAttribute", "useTranslation", "useResource", "api", "mutate"] },
        "object-properties": { exclude: ["[A-Z_-]+", "style", "dateStyle", "timeStyle", "role", "status", "state", "kind", "sessionId", "type", "behavior", "block", "unit", "unitDisplay", "notation", "currency"] },
      }],
    },
  },
);
