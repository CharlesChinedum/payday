"use client";

import { useEffect, useRef } from "react";
import type { AnimationItem } from "lottie-web";

interface LottieProps {
  /** A Lottie JSON document from src/lottie. */
  data: object;
  label: string;
  loop?: boolean;
  className?: string;
}

/**
 * Plays a Lottie animation with the SVG-only player, loaded on demand so it never
 * blocks first paint. With reduced motion it shows the final frame and does not play.
 */
export function Lottie({ data, label, loop = true, className }: LottieProps) {
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let item: AnimationItem | undefined;
    let cancelled = false;
    import("lottie-web/build/player/lottie_light").then(({ default: lottie }) => {
      if (cancelled || !container.current) return;
      const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      item = lottie.loadAnimation({
        container: container.current,
        renderer: "svg",
        loop: loop && !still,
        autoplay: !still,
        // lottie-web completes the document in place; each player gets its own copy.
        animationData: structuredClone(data),
      });
      if (still) item.goToAndStop(item.totalFrames - 1, true);
    });
    return () => {
      cancelled = true;
      item?.destroy();
    };
  }, [data, loop]);

  return <div ref={container} role="img" aria-label={label} className={className} />;
}
