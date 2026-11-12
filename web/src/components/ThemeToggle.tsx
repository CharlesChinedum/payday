"use client";

import { useSyncExternalStore } from "react";
import { THEMES, THEME_KEY, applyTheme, readTheme, type Theme } from "@/lib/theme";
import { MonitorIcon, MoonIcon, SunIcon } from "./icons";

const listeners = new Set<() => void>();
function subscribe(fn: () => void) {
  listeners.add(fn);
  // Another tab changing the theme updates this one too.
  const onStorage = (e: StorageEvent) => {
    if (e.key !== THEME_KEY) return;
    applyTheme(readTheme());
    fn();
  };
  window.addEventListener("storage", onStorage);
  // The header is prerendered as "system"; re-read the stored choice once hydrated.
  fn();
  return () => {
    listeners.delete(fn);
    window.removeEventListener("storage", onStorage);
  };
}

const LABEL: Record<Theme, string> = { system: "System theme", light: "Light theme", dark: "Dark theme" };
const ICON = { system: MonitorIcon, light: SunIcon, dark: MoonIcon } as const;

/** One button that cycles System → Light → Dark; small enough for a phone-width header. */
export function ThemeToggle() {
  const theme = useSyncExternalStore(subscribe, readTheme, () => "system" as Theme);
  const next = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
  const Icon = ICON[theme];
  return (
    <button
      type="button"
      onClick={() => {
        applyTheme(next);
        listeners.forEach((fn) => fn());
      }}
      aria-label={`${LABEL[theme]}. Switch to ${LABEL[next].toLowerCase()}`}
      title={`${LABEL[theme]} (click for ${LABEL[next].toLowerCase()})`}
      className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-muted transition hover:bg-surface-2 hover:text-text active:scale-95"
    >
      <Icon key={theme} className="animate-pop" />
    </button>
  );
}
