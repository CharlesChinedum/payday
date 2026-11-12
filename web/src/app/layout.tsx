import type { Metadata } from "next";
import { Suspense } from "react";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "@fontsource/instrument-serif/400.css";
import "@fontsource/instrument-serif/400-italic.css";
import { SiteHeader } from "@/components/SiteHeader";
import { THEME_SCRIPT } from "@/lib/theme";
import "./globals.css";

export const metadata: Metadata = {
  title: "Payday — payroll that pays every second",
  description: "USDC payroll that streams every second. No gas for workers, cash out to any chain.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // data-theme is set by THEME_SCRIPT before React hydrates, so the server's HTML differs.
    <html lang="en" className="h-full antialiased" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="flex min-h-full flex-col">
        <Suspense>
          <SiteHeader />
        </Suspense>
        <main className="flex-1">{children}</main>
        <footer className="border-t border-border print:hidden">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-6 text-xs text-muted sm:px-6">
            <span>Built at NEAR HACKATHON 2026. Contracts and relayer are open source.</span>
            <a className="underline underline-offset-4 hover:text-text" href="https://github.com/CharlesChinedum/payday">
              github.com/CharlesChinedum/payday
            </a>
          </div>
        </footer>
      </body>
    </html>
  );
}
