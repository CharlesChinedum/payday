"use client";

import { useEffect, useId, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { THEMES, THEME_KEY, applyTheme, readTheme, type Theme } from "@/lib/theme";
import { CheckIcon, ChevronDownIcon, MonitorIcon, MoonIcon, SunIcon } from "./icons";

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
  // The header is rendered as "system" on the server; re-read the stored choice once hydrated.
  fn();
  return () => {
    listeners.delete(fn);
    window.removeEventListener("storage", onStorage);
  };
}

const LABEL: Record<Theme, string> = { system: "System", light: "Light", dark: "Dark" };
const ICON = { system: MonitorIcon, light: SunIcon, dark: MoonIcon } as const;

/**
 * The theme picker: a menu button (WAI-ARIA pattern) with System, Light and Dark. Opens on
 * click, Enter, Space or the arrow keys; arrows, Home and End move between options; Enter or
 * Space picks one; Escape, Tab or a click outside closes it and focus returns to the button.
 */
export function ThemeToggle() {
  const theme = useSyncExternalStore(subscribe, readTheme, () => "system" as Theme);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const items = useRef<(HTMLButtonElement | null)[]>([]);
  const menuId = useId();
  const Icon = ICON[theme];

  function show(index: number) {
    setActive(index);
    setOpen(true);
  }

  function close(returnFocus: boolean) {
    setOpen(false);
    if (returnFocus) button.current?.focus();
  }

  function choose(next: Theme) {
    applyTheme(next);
    listeners.forEach((fn) => fn());
    close(true);
  }

  // Focus follows the active option while the menu is open.
  useEffect(() => {
    if (open) items.current[active]?.focus();
  }, [open, active]);

  // A click or tap anywhere else closes the menu.
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!menu.current?.contains(target) && !button.current?.contains(target)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [open]);

  function onButtonKey(e: KeyboardEvent) {
    if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      show(THEMES.indexOf(theme));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      show(THEMES.length - 1);
    }
  }

  function onMenuKey(e: KeyboardEvent) {
    const last = THEMES.length - 1;
    const moves: Record<string, number> = {
      ArrowDown: active === last ? 0 : active + 1,
      ArrowUp: active === 0 ? last : active - 1,
      Home: 0,
      End: last,
    };
    if (e.key in moves) {
      e.preventDefault();
      setActive(moves[e.key]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close(true);
    } else if (e.key === "Tab") {
      close(false);
    }
  }

  return (
    <div className="relative">
      <button
        ref={button}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`Theme: ${LABEL[theme]}`}
        title={`Theme: ${LABEL[theme]}`}
        onClick={() => (open ? close(false) : show(THEMES.indexOf(theme)))}
        onKeyDown={onButtonKey}
        className={`flex h-8 shrink-0 items-center gap-0.5 rounded-lg px-1.5 text-muted transition hover:bg-surface-2 hover:text-text active:scale-95 ${
          open ? "bg-surface-2 text-text" : ""
        }`}
      >
        <Icon key={theme} className="animate-pop" />
        {/* The chevron needs room the phone-width header does not have. */}
        <ChevronDownIcon className={`hidden h-3 w-3 transition-transform duration-200 sm:block ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div
          ref={menu}
          id={menuId}
          role="menu"
          aria-label="Theme"
          onKeyDown={onMenuKey}
          className="absolute right-0 top-full z-50 mt-2 w-40 animate-pop rounded-xl border border-border bg-surface p-1 shadow-lift"
        >
          {THEMES.map((option, i) => {
            const OptionIcon = ICON[option];
            const selected = option === theme;
            return (
              <button
                key={option}
                ref={(el) => {
                  items.current[i] = el;
                }}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                tabIndex={i === active ? 0 : -1}
                onClick={() => choose(option)}
                onMouseEnter={() => setActive(i)}
                className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm outline-none transition-colors ${
                  selected ? "font-medium text-text" : "text-muted hover:text-text"
                } ${i === active ? "bg-surface-2" : ""}`}
              >
                <OptionIcon />
                <span className="flex-1">{LABEL[option]}</span>
                {selected && <CheckIcon className="text-gold" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
