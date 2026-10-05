"use client";

import { useEffect, useRef, useState } from "react";

/** Copies the page's raw markdown to the clipboard. */
export default function CopyPageButton({ raw }: { raw: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  return (
    <button
      type="button"
      data-copy-page
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(raw);
          setCopied(true);
          if (timer.current !== null) window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => setCopied(false), 1500);
        } catch {
          // Clipboard unavailable; leave label unchanged.
        }
      }}
      className="rounded-md border border-black/[.08] px-2.5 py-1 text-xs font-medium text-zinc-600 transition-colors hover:bg-black/[.04] hover:text-black dark:border-white/[.145] dark:text-zinc-400 dark:hover:bg-white/[.06] dark:hover:text-white"
    >
      {copied ? "Copied" : "Copy page"}
    </button>
  );
}
