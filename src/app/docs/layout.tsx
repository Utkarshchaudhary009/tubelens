import Link from "next/link";
import type { ReactNode } from "react";
import { DOCS_HOME, DOCS_NAV, getDocsSearchIndex } from "@/lib/docs";
import DocsSidebar from "./_components/DocsSidebar";
import MobileDocsNav from "./_components/MobileDocsNav";
import SearchBox from "./_components/SearchBox";
import Toc from "./_components/Toc";

export const runtime = "nodejs";

export default function DocsLayout({ children }: { children: ReactNode }) {
  const index = getDocsSearchIndex();

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-10 border-b border-black/[.08] bg-white/80 backdrop-blur dark:border-white/[.145] dark:bg-black/80">
        <div className="mx-auto flex w-full max-w-7xl items-center gap-4 px-4 py-3 sm:px-6">
          <Link href="/docs" className="shrink-0 text-sm font-semibold">
            TubeLens <span className="font-normal text-zinc-500">Docs</span>
          </Link>
          <div className="ml-auto w-full max-w-xs">
            <SearchBox index={index} />
          </div>
        </div>
      </header>

      {/* Mobile nav: collapsed behind a native disclosure, no JS needed. */}
      <MobileDocsNav home={DOCS_HOME} groups={DOCS_NAV} />

      <div className="mx-auto grid w-full max-w-7xl flex-1 lg:grid-cols-[250px_minmax(0,1fr)] xl:grid-cols-[250px_minmax(0,1fr)_220px]">
        <aside className="hidden border-r border-black/[.08] lg:block dark:border-white/[.145]">
          <div className="sticky top-[57px] max-h-[calc(100vh-57px)] overflow-y-auto px-4 py-6">
            <DocsSidebar home={DOCS_HOME} groups={DOCS_NAV} />
          </div>
        </aside>
        <main className="min-w-0 px-4 py-8 sm:px-8">
          <div className="mx-auto w-full max-w-[720px]">{children}</div>
        </main>
        <aside className="hidden border-l border-black/[.08] xl:block dark:border-white/[.145]">
          <div className="sticky top-[57px] max-h-[calc(100vh-57px)] overflow-y-auto px-5 py-8">
            <Toc />
          </div>
        </aside>
      </div>
    </div>
  );
}
