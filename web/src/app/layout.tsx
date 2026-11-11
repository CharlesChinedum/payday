import type { Metadata } from "next";
import Link from "next/link";
import { config } from "@/lib/config";
import "./globals.css";

export const metadata: Metadata = {
  title: "Payday",
  description: "USDC payroll that streams every second. No gas for workers, cash out to any chain.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">
        <header className="border-b border-border bg-surface">
          <nav className="mx-auto flex max-w-5xl items-center gap-6 px-4 py-3">
            <Link href="/" className="font-semibold tracking-tight">
              Payday
            </Link>
            <Link href="/employer" className="text-sm text-muted hover:text-text">
              Employer
            </Link>
            <Link href="/worker" className="text-sm text-muted hover:text-text">
              Worker
            </Link>
            <span className="ml-auto rounded-full bg-surface-2 px-2.5 py-0.5 text-xs text-muted">
              NEAR {config.networkId}
            </span>
          </nav>
        </header>
        <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8">{children}</main>
        <footer className="mx-auto w-full max-w-5xl px-4 py-6 text-xs text-muted">
          Built at NEAR HACKATHON 2026 ·{" "}
          <a className="underline" href="https://github.com/CharlesChinedum/payday">
            Source
          </a>
        </footer>
      </body>
    </html>
  );
}
