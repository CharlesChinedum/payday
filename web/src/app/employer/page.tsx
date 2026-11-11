import { Suspense } from "react";
import { EmployerView } from "@/components/employer/EmployerView";

export const metadata = { title: "Run payroll · Payday" };

export default function Page() {
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-10">
      <Suspense>
        <EmployerView />
      </Suspense>
    </div>
  );
}
