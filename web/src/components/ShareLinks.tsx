"use client";

import { useSyncExternalStore } from "react";
import { CopyButton } from "./ui";

const noop = () => () => {};

/** This site's origin, for absolute links; "" while rendering on the server. */
export const useOrigin = () => useSyncExternalStore(noop, () => window.location.origin, () => "");

const LINK =
  "inline-flex items-center gap-1.5 rounded-lg border border-border px-2 py-1 text-xs font-medium text-muted transition duration-150 hover:text-text active:scale-95";

/** Copy a link, or post it with a line of text to X, WhatsApp or Telegram. */
export function ShareLinks({ link, text }: { link: string; text: string }) {
  const q = encodeURIComponent;
  return (
    <div className="flex flex-wrap gap-2">
      <CopyButton value={link} label="Copy link" />
      <a className={LINK} target="_blank" rel="noopener noreferrer" href={`https://x.com/intent/post?text=${q(text)}&url=${q(link)}`}>
        Post on X
      </a>
      <a className={LINK} target="_blank" rel="noopener noreferrer" href={`https://wa.me/?text=${q(`${text} ${link}`)}`}>
        WhatsApp
      </a>
      <a className={LINK} target="_blank" rel="noopener noreferrer" href={`https://t.me/share/url?url=${q(link)}&text=${q(text)}`}>
        Telegram
      </a>
    </div>
  );
}
