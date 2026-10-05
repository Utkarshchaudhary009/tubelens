import Link from "next/link";
import { notFound } from "next/navigation";
import {
  DOCS_ORDER,
  getAllDocs,
  parseFrontmatter,
  readDocFile,
  renderMarkdown,
  slugToHref,
} from "@/lib/docs";
import CopyPageButton from "../_components/CopyPageButton";
import DocsEnhance from "../_components/DocsEnhance";

export const runtime = "nodejs";

export function generateStaticParams(): { slug?: string[] }[] {
  return getAllDocs().map(({ slug }) => (slug.length === 0 ? {} : { slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug?: string[] }>;
}) {
  const { slug = [] } = await params;
  const raw = readDocFile(slug);
  if (!raw) return { title: "Not found — TubeLens Docs" };
  const { title, description } = parseFrontmatter(raw);
  return { title: `${title} — TubeLens Docs`, description };
}

const LANDING_CARDS = [
  {
    title: "Start building",
    description: "Make your first five calls: health, search, video, playlist.",
    href: "/docs/start-building",
  },
  {
    title: "Products",
    description:
      "Watch, Channels, Playlists, Music, Feeds — which route to use.",
    href: "/docs/products",
  },
  {
    title: "API reference",
    description: "Base URL, auth, envelope, pagination, rate limits, caching.",
    href: "/docs/api/overview",
  },
  {
    title: "Errors",
    description: "Error codes, hints, headers, and retry guidance.",
    href: "/docs/errors",
  },
];

function Breadcrumbs({ title }: { title: string }) {
  return (
    <nav aria-label="Breadcrumb" className="mb-4 text-sm text-zinc-500">
      <Link href="/docs" className="hover:underline">
        Docs
      </Link>
      <span aria-hidden="true" className="mx-1.5">
        /
      </span>
      <span aria-current="page" className="text-zinc-800 dark:text-zinc-200">
        {title}
      </span>
    </nav>
  );
}

function PrevNext({ href }: { href: string }) {
  const idx = DOCS_ORDER.findIndex((item) => item.href === href);
  if (idx === -1) return null;
  const prev = idx > 0 ? DOCS_ORDER[idx - 1] : null;
  const next = idx < DOCS_ORDER.length - 1 ? DOCS_ORDER[idx + 1] : null;
  if (!prev && !next) return null;
  return (
    <nav
      aria-label="More docs"
      className="mt-12 grid gap-3 border-t border-black/[.08] pt-6 sm:grid-cols-2 dark:border-white/[.145]"
    >
      {prev ? (
        <Link
          href={prev.href}
          rel="prev"
          className="rounded-lg border border-black/[.08] p-4 transition-colors hover:bg-black/[.02] dark:border-white/[.145] dark:hover:bg-white/[.04]"
        >
          <span className="block text-xs text-zinc-500">Previous</span>
          <span className="block text-sm font-medium">{prev.title}</span>
        </Link>
      ) : (
        <span />
      )}
      {next ? (
        <Link
          href={next.href}
          rel="next"
          className="rounded-lg border border-black/[.08] p-4 text-right transition-colors hover:bg-black/[.02] dark:border-white/[.145] dark:hover:bg-white/[.04]"
        >
          <span className="block text-xs text-zinc-500">Next</span>
          <span className="block text-sm font-medium">{next.title}</span>
        </Link>
      ) : null}
    </nav>
  );
}

function Landing({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div>
      <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
      {description ? (
        <p className="mt-3 text-lg text-zinc-600 dark:text-zinc-400">
          {description}
        </p>
      ) : null}
      <div className="mt-8 grid gap-4 sm:grid-cols-2">
        {LANDING_CARDS.map((card) => (
          <Link
            key={card.href}
            href={card.href}
            className="group rounded-xl border border-black/[.08] p-5 transition-colors hover:bg-black/[.02] dark:border-white/[.145] dark:hover:bg-white/[.04]"
          >
            <span className="block font-medium group-hover:underline">
              {card.title}
            </span>
            <span className="mt-1 block text-sm text-zinc-600 dark:text-zinc-400">
              {card.description}
            </span>
          </Link>
        ))}
      </div>
      <p className="mt-8 text-sm text-zinc-500">
        New here? Start with{" "}
        <Link
          href="/docs/quickstart"
          className="font-medium underline underline-offset-2"
        >
          Quickstart
        </Link>
        .
      </p>
    </div>
  );
}

export default async function DocsPage({
  params,
}: {
  params: Promise<{ slug?: string[] }>;
}) {
  const { slug = [] } = await params;
  const raw = readDocFile(slug);
  if (!raw) notFound();
  const doc = parseFrontmatter(raw);
  const html = renderMarkdown(doc.body);
  const href = slugToHref(slug);

  if (slug.length === 0) {
    return <Landing title={doc.title} description={doc.description} />;
  }

  return (
    <div>
      <div className="flex items-start justify-between gap-4">
        <Breadcrumbs title={doc.title} />
        <CopyPageButton raw={doc.body} />
      </div>
      <article data-docs-article>
        {doc.description ? (
          <p className="mb-4 text-lg text-zinc-600 dark:text-zinc-400">
            {doc.description}
          </p>
        ) : null}
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: html is built from escaped markdown (escapeHtml) with an allowlist of tags */}
        <div dangerouslySetInnerHTML={{ __html: html }} />
      </article>
      <DocsEnhance />
      <PrevNext href={href} />
    </div>
  );
}
