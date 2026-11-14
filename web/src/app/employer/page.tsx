import type { Metadata } from "next";
import { Suspense } from "react";
import { EmployerView } from "@/components/employer/EmployerView";
import { shortId } from "@/lib/address";
import { parseRequest, requestCardPath, requestSummary } from "@/lib/request";

const BASE: Metadata = { title: "Run payroll · Payday" };

/** A request-to-be-paid link previews as a card with the amount, the period and who is asking. */
export async function generateMetadata({ searchParams }: PageProps<"/employer">): Promise<Metadata> {
  const params = await searchParams;
  const query = new URLSearchParams();
  for (const key of ["pay", "amount", "days", "note"]) {
    const value = params[key];
    if (typeof value === "string") query.set(key, value);
  }
  const request = parseRequest(query);
  if (!request) return BASE;

  const title = `Pay ${shortId(request.worker)} ${requestSummary(request)}`;
  const description = `${request.note ? `${request.note}. ` : ""}A salary that streams by the second through Payday, on NEAR. Open the link to check it and fund it.`;
  const image = { url: requestCardPath(request), width: 1200, height: 630, alt: `Payment request: ${title}` };
  return {
    title: `${title} · Payday`,
    description,
    openGraph: { title, description, images: [image], type: "website", siteName: "Payday" },
    twitter: { card: "summary_large_image", title, description, images: [image] },
  };
}

export default function Page() {
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-10">
      <Suspense>
        <EmployerView />
      </Suspense>
    </div>
  );
}
