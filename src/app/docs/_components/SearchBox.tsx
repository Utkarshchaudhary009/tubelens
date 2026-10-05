"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { DocsSearchEntry } from "@/lib/docs";

function matches(entry: DocsSearchEntry, q: string): boolean {
  const hay = `${entry.title} ${entry.headings.join(" ")}`.toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => hay.includes(word));
}

export default function SearchBox({ index }: { index: DocsSearchEntry[] }) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
        setOpen(true);
      } else if (e.key === "Escape") {
        setOpen(false);
        inputRef.current?.blur();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const results =
    query.trim() === ""
      ? []
      : index.filter((entry) => matches(entry, query)).slice(0, 8);

  return (
    <div className="relative w-full">
      <div className="flex items-center gap-2 rounded-lg border border-black/[.08] bg-white px-3 py-1.5 text-sm dark:border-white/[.145] dark:bg-black">
        <svg
          aria-hidden="true"
          width="14"
          height="14"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className="shrink-0 text-zinc-400"
        >
          <circle cx="7" cy="7" r="5" />
          <path d="m11 11 3 3" />
        </svg>
        <input
          ref={inputRef}
          type="search"
          aria-label="Search docs"
          aria-controls="docs-search-results"
          placeholder="Search docs"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          className="w-full bg-transparent outline-none placeholder:text-zinc-400"
        />
        <kbd className="hidden shrink-0 rounded border border-black/[.08] px-1.5 py-0.5 font-mono text-[10px] text-zinc-400 sm:block dark:border-white/[.145]">
          ⌘K
        </kbd>
      </div>
      {open && results.length > 0 ? (
        <div
          id="docs-search-results"
          className="absolute inset-x-0 top-full z-20 mt-1 overflow-hidden rounded-lg border border-black/[.08] bg-white shadow-lg dark:border-white/[.145] dark:bg-zinc-950"
        >
          <ul>
            {results.map((entry) => (
              <li key={entry.href}>
                <Link
                  href={entry.href}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    setQuery("");
                    setOpen(false);
                  }}
                  className="block px-3 py-2 text-sm hover:bg-black/[.04] dark:hover:bg-white/[.06]"
                >
                  <span className="font-medium">{entry.title}</span>
                  {entry.headings.length > 0 ? (
                    <span className="block truncate text-xs text-zinc-500">
                      {entry.headings.slice(0, 3).join(" · ")}
                    </span>
                  ) : null}
                </Link>
              </li>
            ))}
          </ul>
          <output className="sr-only">
            {`${results.length} matching ${results.length === 1 ? "doc" : "docs"}`}
          </output>
        </div>
      ) : null}
    </div>
  );
}
