"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { config } from "@/lib/config";
import { Logo } from "./icons";
import { ThemeToggle } from "./ThemeToggle";
import { LiveDot } from "./ui";

const LINKS = [
  { href: "/employer", label: "Run payroll" },
  { href: "/worker", label: "My pay" },
  { href: "/dao", label: "DAOs" },
] as const;

export function SiteHeader() {
  const pathname = usePathname();
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-bg/85 backdrop-blur-md print:hidden">
      <nav className="mx-auto flex max-w-6xl items-center gap-1 px-4 py-3 sm:gap-2 sm:px-6">
        <Link href="/" className="group mr-1 flex items-center gap-1.5 sm:mr-6 sm:gap-2">
          <Logo className="h-7 w-7 transition-transform duration-300 group-hover:scale-105" />
          <span className="text-lg font-semibold tracking-tight">Payday</span>
        </Link>
        {LINKS.map(({ href, label }) => {
          const active = pathname === href;
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? "page" : undefined}
              className={`whitespace-nowrap rounded-lg px-2 py-1.5 text-sm transition-colors sm:px-3 ${
                active ? "bg-surface-2 font-medium text-text" : "text-muted hover:text-text"
              }`}
            >
              {label}
            </Link>
          );
        })}
        <span className="ml-auto hidden items-center gap-2 rounded-full border border-border px-3 py-1 text-xs text-muted sm:inline-flex">
          <LiveDot />
          NEAR {config.networkId}
        </span>
        <span className="ml-auto sm:ml-1">
          <ThemeToggle />
        </span>
      </nav>
    </header>
  );
}
