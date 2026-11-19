import { useEffect, useState } from "react";
import { useMediaQuery } from "./layers.js";

export type Theme = "system" | "light" | "dark";
/** The page background per theme (`--background` in styles.css), for `<meta name="theme-color">`. */
const THEME_COLORS = { light: "#f4efe6", dark: "#1e1c1b" } as const;

function storedTheme(): Theme {
  try { const theme = localStorage.getItem("tomo-theme"); return theme === "light" || theme === "dark" ? theme : "system"; }
  catch { return "system"; }
}

/** The chosen color theme, applied to the document (and the browser's own chrome) and remembered. */
export function useTheme(): [Theme, (theme: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(storedTheme);
  const systemDark = useMediaQuery("(prefers-color-scheme: dark)");
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.classList.toggle("dark", theme === "dark" || (theme === "system" && systemDark));
    // The browser's own chrome (tab strip, phone status bar) follows the chosen theme, not only the OS one.
    for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
      const dark = theme === "system" ? meta.media.includes("dark") : theme === "dark";
      meta.content = dark ? THEME_COLORS.dark : THEME_COLORS.light;
    }
    try { localStorage.setItem("tomo-theme", theme); } catch { /* Storage can be unavailable. */ }
  }, [theme, systemDark]);
  return [theme, setTheme];
}
