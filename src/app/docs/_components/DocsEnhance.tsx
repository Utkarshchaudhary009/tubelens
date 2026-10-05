"use client";

import { useEffect } from "react";

/**
 * Progressive enhancement for server-rendered docs HTML:
 * wires up the `Copy` buttons on code blocks (no extra deps).
 */
export default function DocsEnhance() {
  useEffect(() => {
    const article = document.querySelector("[data-docs-article]");
    if (!article) return;
    const onClick = async (e: Event) => {
      const btn = (e.target as HTMLElement).closest("[data-docs-copy]");
      if (!(btn instanceof HTMLButtonElement)) return;
      const block = btn.closest("[data-code-block]");
      const code = block?.querySelector("pre code")?.textContent ?? "";
      if (!code) return;
      try {
        await navigator.clipboard.writeText(code);
      } catch {
        // Clipboard API unavailable (permissions); fall back to selection.
        const range = document.createRange();
        const node = block?.querySelector("pre code");
        if (node) {
          range.selectNodeContents(node);
          const sel = window.getSelection();
          sel?.removeAllRanges();
          sel?.addRange(range);
        }
        return;
      }
      const original = btn.textContent;
      btn.textContent = "Copied";
      window.setTimeout(() => {
        btn.textContent = original;
      }, 1500);
    };
    article.addEventListener("click", onClick);
    return () => article.removeEventListener("click", onClick);
  }, []);

  return null;
}
