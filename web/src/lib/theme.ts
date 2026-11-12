export type Theme = "system" | "light" | "dark";

export const THEME_KEY = "payday:theme";
export const THEMES: readonly Theme[] = ["system", "light", "dark"];

/**
 * Runs in <head> before the first paint so a stored choice never flashes the other theme.
 * A constant string: nothing user-controlled is ever inlined.
 */
export const THEME_SCRIPT = `try{var t=localStorage.getItem("${THEME_KEY}");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;

export function readTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    return "system";
  }
}

/** Applies and remembers a theme; "system" removes the override so the OS setting wins. */
export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  if (theme === "system") delete root.dataset.theme;
  else root.dataset.theme = theme;
  try {
    if (theme === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Private mode: the choice still applies for this page view.
  }
}
