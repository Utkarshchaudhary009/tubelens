"use client";

import { useRef } from "react";
import type { DocsNavGroup, DocsNavItem } from "@/lib/docs";
import DocsSidebar from "./DocsSidebar";

/** Mobile nav: native disclosure that closes itself on navigation. */
export default function MobileDocsNav({
  home,
  groups,
}: {
  home: DocsNavItem;
  groups: DocsNavGroup[];
}) {
  const ref = useRef<HTMLDetailsElement>(null);

  return (
    <details
      ref={ref}
      className="border-b border-black/[.08] lg:hidden dark:border-white/[.145]"
    >
      <summary className="cursor-pointer px-4 py-2.5 text-sm font-medium select-none">
        Menu
      </summary>
      <div className="px-4 pb-4">
        <DocsSidebar
          home={home}
          groups={groups}
          onNavigate={() => ref.current?.removeAttribute("open")}
        />
      </div>
    </details>
  );
}
