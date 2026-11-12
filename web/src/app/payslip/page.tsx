import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { PayslipView } from "@/components/payslip/PayslipView";
import { isNearAccountId, shortId } from "@/lib/address";
import { config } from "@/lib/config";
import { HIDE_AMOUNT, monthOf, monthPeriod, payslipCardPath } from "@/lib/payslip";

const BASE: Metadata = { title: "Payslip · Payday", robots: { index: false } };

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

/** The link preview: a card with the month, the amount and who was paid, drawn from the chain. */
export async function generateMetadata({ searchParams }: PageProps<"/payslip">): Promise<Metadata> {
  const params = await searchParams;
  await connection();
  const worker = one(params.worker).trim().toLowerCase();
  const nowSecs = Math.floor(Date.now() / 1000);
  const month = one(params.month) || monthOf(nowSecs);
  const period = monthPeriod(month, nowSecs);
  if (!isNearAccountId(worker) || !period) return BASE;

  const title = `${period.label} payslip · ${shortId(worker)}`;
  const description = `Salary paid by the second through Payday, read live from NEAR ${config.networkId}. Anyone can check every figure.`;
  const image = {
    url: payslipCardPath(worker, period.month, one(params.amount) === HIDE_AMOUNT),
    width: 1200,
    height: 630,
    alt: `Payday payslip for ${worker}, ${period.label}`,
  };
  return {
    ...BASE,
    title,
    description,
    openGraph: { title, description, images: [image], type: "website", siteName: "Payday" },
    twitter: { card: "summary_large_image", title, description, images: [image] },
  };
}

/** Marks the page as request-time on purpose (its metadata reads the query), keeping the shell static. */
async function Connection() {
  await connection();
  return null;
}

export default function Page() {
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-10 print:p-0">
      <Suspense>
        <PayslipView />
      </Suspense>
      <Suspense>
        <Connection />
      </Suspense>
    </div>
  );
}
