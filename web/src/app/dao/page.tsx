import { Suspense } from "react";
import { DaoView } from "@/components/dao/DaoView";

export const metadata = { title: "DAO payroll · Payday" };

export default function Page() {
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-10">
      <Suspense>
        <DaoView />
      </Suspense>
    </div>
  );
}
