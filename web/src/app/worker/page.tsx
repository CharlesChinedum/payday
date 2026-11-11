import { Suspense } from "react";
import { WorkerView } from "@/components/WorkerView";

export const metadata = { title: "Worker · Payday" };

export default function Page() {
  return (
    <Suspense fallback={<p className="text-muted">Loading…</p>}>
      <WorkerView />
    </Suspense>
  );
}
