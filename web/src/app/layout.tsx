import type { Metadata } from "next";
import { headers } from "next/headers";
import { Suspense } from "react";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "@fontsource/instrument-serif/400.css";
import "@fontsource/instrument-serif/400-italic.css";
import { SiteHeader } from "@/components/SiteHeader";
import { THEME_SCRIPT } from "@/lib/theme";
import "./globals.css";

/** Absolute base for link previews: the production domain on Vercel, this machine locally. */
const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ??
  (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "http://localhost:3000");

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: "Payday — payroll that pays every second",
  description: "USDC payroll that streams every second. No gas for workers, cash out to any chain.",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  // Set by src/proxy.ts for this request; reading it renders every page per request.
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    // data-theme is set by THEME_SCRIPT before React hydrates, so the server's HTML differs.
    <html lang="en" className="h-full antialiased" suppressHydrationWarning>
      <head>
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
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
