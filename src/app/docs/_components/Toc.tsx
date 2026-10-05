"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

type TocItem = { id: string; text: string; level: number };

/**
 * Right-rail TOC. Headings (H2/H3 with ids) are server-rendered in the
 * article; this component builds the list from the DOM and highlights the
 * active section via IntersectionObserver. Rebuilds on client navigation.
 */
export default function Toc() {
  const pathname = usePathname();
  const [items, setItems] = useState<TocItem[]>([]);
  const [active, setActive] = useState<string>("");

  // NOTE: pathname below is an intentional re-trigger — the layout persists
  // across client navigations, so the TOC must rebuild when the route changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run on route change
  useEffect(() => {
    const article = document.querySelector("[data-docs-article]");
    const headings = Array.from(
      article?.querySelectorAll("h2[id], h3[id]") ?? [],
    ).map((el) => ({
      id: el.id,
      text: (el.textContent ?? "").replace(/#$/, "").trim(),
      level: el.tagName === "H2" ? 2 : 3,
    }));
    setItems(headings);
    setActive("");
    if (headings.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setActive(entry.target.id);
        }
      },
      { rootMargin: "-80px 0px -70% 0px" },
    );
    for (const h of headings) {
      const el = document.getElementById(h.id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [pathname]);

  // Card-grid landing has no sections to list (trailing slash normalized).
  if (pathname.replace(/\/+$/, "") === "/docs") return null;

  return (
    <nav aria-label="On this page" data-docs-toc>
      <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
        On this page
      </p>
      {items.length === 0 ? (
        <p className="text-sm text-zinc-400">No sections</p>
      ) : (
        <ul className="space-y-0.5 border-l border-black/[.08] dark:border-white/[.145]">
          {items.map((item) => (
            <li key={item.id}>
              <a
                href={`#${item.id}`}
                aria-current={active === item.id ? "true" : undefined}
                className={`-ml-px block border-l-2 py-1 text-sm transition-colors ${
                  item.level === 3 ? "pl-6" : "pl-3"
                } ${
                  active === item.id
                    ? "border-black font-medium text-black dark:border-white dark:text-white"
                    : "border-transparent text-zinc-500 hover:text-black dark:text-zinc-400 dark:hover:text-white"
                }`}
              >
                {item.text}
              </a>
            </li>
          ))}
        </ul>
      )}
    </nav>
  );
}
