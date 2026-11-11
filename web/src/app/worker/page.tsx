import { Suspense } from "react";
import { WorkerView } from "@/components/worker/WorkerView";

export const metadata = { title: "My pay · Payday" };

export default function Page() {
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-10">
      <Suspense>
        <WorkerView />
      </Suspense>
    </div>
  );
}
