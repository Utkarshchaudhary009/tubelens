"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { DocsNavGroup, DocsNavItem } from "@/lib/docs";

function NavLinks({
  items,
  current,
  onNavigate,
}: {
  items: DocsNavItem[];
  current: string;
  onNavigate?: () => void;
}) {
  return (
    <ul className="space-y-0.5">
      {items.map((item) => {
        const active = current === item.href;
        return (
          <li key={item.href}>
            <Link
              href={item.href}
              aria-current={active ? "page" : undefined}
              onClick={onNavigate}
              className={`block rounded-md px-3 py-1.5 text-sm transition-colors ${
                active
                  ? "bg-black/[.06] font-medium text-black dark:bg-white/[.08] dark:text-white"
                  : "text-zinc-600 hover:bg-black/[.04] hover:text-black dark:text-zinc-400 dark:hover:bg-white/[.06] dark:hover:text-white"
              }`}
            >
              {item.title}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

export default function DocsSidebar({
  home,
  groups,
  onNavigate,
}: {
  home: DocsNavItem;
  groups: DocsNavGroup[];
  onNavigate?: () => void;
}) {
  const pathname = (usePathname() ?? "").replace(/\/+$/, "") || "/";
  return (
    <nav aria-label="Docs sections" className="space-y-5">
      <div>
        <Link
          href={home.href}
          aria-current={pathname === home.href ? "page" : undefined}
          onClick={onNavigate}
          className={`block rounded-md px-3 py-1.5 text-sm transition-colors ${
            pathname === home.href
              ? "bg-black/[.06] font-medium text-black dark:bg-white/[.08] dark:text-white"
              : "text-zinc-600 hover:bg-black/[.04] hover:text-black dark:text-zinc-400 dark:hover:bg-white/[.06] dark:hover:text-white"
          }`}
        >
          {home.title}
        </Link>
      </div>
      {groups.map((group) => (
        <details key={group.label} open className="group">
          <summary className="cursor-pointer list-none px-3 pb-1 text-xs font-semibold uppercase tracking-wider text-zinc-400 select-none dark:text-zinc-500">
            {group.label}
          </summary>
          <NavLinks
            items={group.items}
            current={pathname}
            onNavigate={onNavigate}
          />
        </details>
      ))}
    </nav>
  );
}
