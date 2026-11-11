"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { config } from "@/lib/config";
import { Logo } from "./icons";
import { LiveDot } from "./ui";

const LINKS = [
  { href: "/employer", label: "Run payroll" },
  { href: "/worker", label: "My pay" },
] as const;

export function SiteHeader() {
  const pathname = usePathname();
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-bg/85 backdrop-blur-md">
      <nav className="mx-auto flex max-w-6xl items-center gap-1 px-4 py-3 sm:gap-2 sm:px-6">
        <Link href="/" className="group mr-2 flex items-center gap-2 sm:mr-6">
          <Logo className="h-6 w-6 transition-transform duration-300 group-hover:rotate-90" />
          <span className="display text-2xl">Payday</span>
        </Link>
        {LINKS.map(({ href, label }) => {
          const active = pathname === href;
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? "page" : undefined}
              className={`whitespace-nowrap rounded-lg px-2.5 py-1.5 text-sm transition-colors sm:px-3 ${
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
      </nav>
    </header>
  );
}
