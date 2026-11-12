import { Suspense } from "react";
import { PayslipView } from "@/components/payslip/PayslipView";

export const metadata = { title: "Payslip · Payday", robots: { index: false } };

export default function Page() {
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-10 print:p-0">
      <Suspense>
        <PayslipView />
      </Suspense>
    </div>
  );
}
