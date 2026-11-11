import { Suspense } from "react";
import { EmployerView } from "@/components/EmployerView";

export const metadata = { title: "Employer · Payday" };

export default function Page() {
  return (
    <Suspense fallback={<p className="text-muted">Loading…</p>}>
      <EmployerView />
    </Suspense>
  );
}
