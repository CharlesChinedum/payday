"use client";

import flow from "@/lottie/flow.json";
import waiting from "@/lottie/waiting.json";
import { Lottie } from "./Lottie";

export function FlowAnimation({ className }: { className?: string }) {
  return (
    <Lottie
      data={flow}
      label="Salary flowing from an employer, through Payday, to three workers"
      className={className}
    />
  );
}

export function WaitingAnimation({ className }: { className?: string }) {
  return <Lottie data={waiting} label="Waiting" className={className} />;
}
