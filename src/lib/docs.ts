import fs from "node:fs";
import path from "node:path";
import { cache } from "react";

export const DOCS_DIR = path.join(process.cwd(), "docs");

export type DocsNavItem = { title: string; href: string };
export type DocsNavGroup = { label: string; items: DocsNavItem[] };

export const DOCS_HOME: DocsNavItem = {
  title: "Introduction",
  href: "/docs",
};

/** Sidebar nav, mirroring the Vercel/Clerk grouped style. */
export const DOCS_NAV: DocsNavGroup[] = [
  {
    label: "Start",
    items: [
      { title: "Quickstart", href: "/docs/quickstart" },
      { title: "How to start", href: "/docs/start-building" },
      { title: "Products", href: "/docs/products" },
    ],
  },
  {
    label: "Reference",
    items: [
      { title: "API Overview", href: "/docs/api/overview" },
      { title: "Errors", href: "/docs/errors" },
    ],
  },
];

/** Flat page order for breadcrumbs + prev/next footer. */
export const DOCS_ORDER: DocsNavItem[] = [
  DOCS_HOME,
  ...DOCS_NAV.flatMap((g) => g.items),
];

export type DocMeta = { title: string; description: string };
export type Doc = DocMeta & { body: string };
export type DocHeading = { level: 2 | 3; id: string; text: string };
export type DocsSearchEntry = {
  title: string;
  href: string;
  headings: string[];
};

export function listDocFiles(dir: string, base = ""): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listDocFiles(full, rel));
    } else if (entry.name.endsWith(".mdx")) {
      out.push(rel);
    }
  }
  return out.sort();
}

export function slugToHref(slug: string[]): string {
  return slug.length === 0 ? "/docs" : `/docs/${slug.join("/")}`;
}

export function fileToSlug(rel: string): string[] {
  const noExt = rel.replace(/\.mdx$/, "");
  return noExt === "index" ? [] : noExt.split("/");
}

export function hrefToSlug(href: string): string[] {
  const rest = href.replace(/^\/docs\/?/, "");
  return rest === "" ? [] : rest.split("/");
}

export function slugToFile(slug: string[]): string | null {
  // Guard against path traversal: slug parts must be plain file/dir names.
  // Parts are percent-decoded first so `%2e%2e` / `%2f` can't smuggle separators.
  for (const p of slug) {
    let decoded = p;
    try {
      decoded = decodeURIComponent(p);
    } catch {
      return null;
    }
    if (
      decoded === "" ||
      decoded === "." ||
      decoded === ".." ||
      decoded.includes("/") ||
      decoded.includes("\\")
    ) {
      return null;
    }
  }
  const rel = slug.length === 0 ? "index.mdx" : `${slug.join("/")}.mdx`;
  const full = path.join(DOCS_DIR, rel);
  if (!full.startsWith(`${DOCS_DIR}${path.sep}`) && full !== DOCS_DIR)
    return null;
  return full;
}

/**
 * Read a doc file, returning null when it is missing/unreadable.
 * Single stat+read in one try/catch (no existsSync pre-check); callers
 * treat null as not-found, so a file vanishing mid-request is a 404, not a 500.
 */
export function readDocFile(slug: string[]): string | null {
  const file = slugToFile(slug);
  if (!file) return null;
  try {
    if (!fs.statSync(file).isFile()) return null;
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

export function parseFrontmatter(raw: string): Doc {
  // Tolerate BOM + CRLF so editor-saved files parse the same way.
  const text = raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const match = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  let title = "";
  let description = "";
  let body = text;
  if (match) {
    const fm = match[1];
    body = match[2];
    for (const line of fm.split("\n")) {
      const m = line.match(/^\s*(title|description)\s*:\s*(.*)\s*$/);
      if (m) {
        const value = m[2].replace(/^["']|["']$/g, "");
        if (m[1] === "title") title = value;
        else description = value;
      }
    }
  }
  const h1 = body.match(/^#\s+(.+)\s*$/m);
  if (!title && h1) title = h1[1].trim();
  return { title: title || "Docs", description, body: body.trim() };
}

export function slugifyHeading(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/`([^`]*)`/g, "$1")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\*\*?([^*]*)\*\*?/g, "$1")
      .replace(/[^a-z0-9\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-") || "section"
  );
}

/** Plain-text version of a heading line for TOC / search. */
export function plainHeadingText(text: string): string {
  return text
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\*\*?([^*]*)\*\*?/g, "$1")
    .trim();
}

function uniqueIds(texts: string[]): string[] {
  const seen = new Map<string, number>();
  return texts.map((t) => {
    const base = slugifyHeading(t);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n === 0 ? base : `${base}-${n}`;
  });
}

/**
 * H2/H3 headings with stable ids (must match renderMarkdown).
 * H2/H3-only is deliberate: no doc file uses ####, and deeper levels would
 * clutter the right-rail TOC. H4+ lines fall through to plain paragraphs.
 */
export function extractHeadings(md: string): DocHeading[] {
  const texts: { level: 2 | 3; raw: string }[] = [];
  for (const line of md.split("\n")) {
    const m = line.trim().match(/^(#{2,3})\s+(.*)$/);
    if (m)
      texts.push({ level: m[1].length as 2 | 3, raw: plainHeadingText(m[2]) });
  }
  const ids = uniqueIds(texts.map((t) => t.raw));
  return texts.map((t, i) => ({ level: t.level, id: ids[i], text: t.raw }));
}

export function getAllDocs(): { slug: string[]; meta: DocMeta }[] {
  return loadAllDocs().map(({ slug, doc }) => ({
    slug,
    meta: { title: doc.title, description: doc.description },
  }));
}

export function getDocsSearchIndex(): DocsSearchEntry[] {
  return loadAllDocs().map(({ slug, doc }) => ({
    title: doc.title,
    href: slugToHref(slug),
    headings: extractHeadings(doc.body).map((h) => h.text),
  }));
}

// Single directory walk + one read per file, shared by getAllDocs and
// getDocsSearchIndex and memoized per request. Unreadable files are skipped.
const loadAllDocs = cache((): { slug: string[]; doc: Doc }[] => {
  if (!fs.existsSync(DOCS_DIR)) return [];
  const out: { slug: string[]; doc: Doc }[] = [];
  for (const rel of listDocFiles(DOCS_DIR)) {
    try {
      const raw = fs.readFileSync(path.join(DOCS_DIR, rel), "utf8");
      out.push({ slug: fileToSlug(rel), doc: parseFrontmatter(raw) });
    } catch {
      // Skip unreadable files; docs UI degrades to fewer entries, not a 500.
    }
  }
  return out;
});

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Fail-closed href allowlist for markdown links. Only same-document
 * fragments, single-leading-slash site paths, and http(s) URLs survive;
 * protocol-relative (`//evil.com`), `javascript:`, `data:`, and friends
 * collapse to "#". Case-insensitive: `JAVASCRIPT:` is rejected too.
 */
export function sanitizeHref(href: string): string {
  const h = href.trim();
  if (/^https?:\/\//i.test(h)) return h;
  if (h.startsWith("/") && !h.startsWith("//")) return h;
  if (h.startsWith("#")) return h;
  return "#";
}

function renderInline(s: string): string {
  // s is already HTML-escaped; allowlist: code spans, links, bold.
  const codeSpans: string[] = [];
  const codeToken = (n: number) => `@@DOCSCODE-${n}@@`;
  s = s.replace(/`([^`\n]+)`/g, (_, code: string) => {
    codeSpans.push(
      `<code class="rounded bg-black/[.06] px-1 py-0.5 font-mono text-[0.9em] dark:bg-white/[.08]">${code}</code>`,
    );
    return codeToken(codeSpans.length - 1);
  });
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text: string, href: string) => {
    const safe = sanitizeHref(href);
    return `<a class="font-medium underline underline-offset-2" href="${safe}">${text}</a>`;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  for (let i = 0; i < codeSpans.length; i++) {
    s = s.replace(codeToken(i), () => codeSpans[i]);
  }
  return s;
}

const CALLOUT_STYLES: Record<string, { label: string; cls: string }> = {
  TIP: {
    label: "Tip",
    cls: "border-green-500/40 bg-green-500/[.07] text-green-950 dark:text-green-100",
  },
  NOTE: {
    label: "Note",
    cls: "border-blue-500/40 bg-blue-500/[.07] text-blue-950 dark:text-blue-100",
  },
  WARNING: {
    label: "Warning",
    cls: "border-amber-500/40 bg-amber-500/[.08] text-amber-950 dark:text-amber-100",
  },
  CAUTION: {
    label: "Caution",
    cls: "border-red-500/40 bg-red-500/[.07] text-red-950 dark:text-red-100",
  },
  DANGER: {
    label: "Danger",
    cls: "border-red-500/40 bg-red-500/[.07] text-red-950 dark:text-red-100",
  },
  IMPORTANT: {
    label: "Important",
    cls: "border-purple-500/40 bg-purple-500/[.07] text-purple-950 dark:text-purple-100",
  },
};

function renderCallout(kind: string, lines: string[]): string {
  const style = CALLOUT_STYLES[kind] ?? CALLOUT_STYLES.NOTE;
  const body = lines
    .map(
      (l) => `<p class="my-1.5 leading-7">${renderInline(escapeHtml(l))}</p>`,
    )
    .join("\n");
  return `<div data-callout="${kind.toLowerCase()}" class="my-4 rounded-lg border px-4 py-2 text-sm ${style.cls}"><p class="my-1.5 font-semibold">${style.label}</p>\n${body}</div>`;
}

export function renderMarkdown(md: string): string {
  // Pull out fenced code blocks first so inner content is untouched.
  const fences: { lang: string; html: string }[] = [];
  const fenceToken = (n: number) => `@@DOCSFENCE-${n}@@`;
  md = md.replace(
    /```(\w*)\n([\s\S]*?)```/g,
    (_, lang: string, code: string) => {
      const label = lang ? escapeHtml(lang) : "code";
      const html =
        `<div data-code-block class="relative my-4 overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-800">` +
        `<div class="flex items-center justify-between bg-zinc-100 px-4 py-1.5 text-xs text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400"><span class="font-mono">${label}</span><button type="button" data-docs-copy class="rounded border border-zinc-300 px-2 py-0.5 font-medium transition-colors hover:bg-zinc-200 dark:border-zinc-700 dark:hover:bg-zinc-800">Copy</button></div>` +
        `<pre class="overflow-x-auto bg-zinc-950 p-4 text-sm leading-6 text-zinc-50"><code>${escapeHtml(code.replace(/\n$/, ""))}</code></pre></div>`;
      fences.push({ lang, html });
      return fenceToken(fences.length - 1);
    },
  );

  // Pre-assign heading ids so TOC matches rendered output.
  const headingTexts: string[] = [];
  for (const line of md.split("\n")) {
    const m = line.trim().match(/^#{2,3}\s+(.*)$/);
    if (m) headingTexts.push(m[1]);
  }
  const headingIds = uniqueIds(headingTexts);
  let headingIdx = 0;

  const lines = md.split("\n");
  const html: string[] = [];
  let i = 0;
  const flushFence = (line: string): string =>
    line.replace(
      /@@DOCSFENCE-(\d+)@@/g,
      (_, n: string) => fences[Number(n)]?.html ?? "",
    );

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed === "" || /^@@DOCSFENCE-\d+@@$/.test(trimmed)) {
      if (trimmed !== "") html.push(flushFence(trimmed));
      i++;
      continue;
    }

    const heading = trimmed.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      const cls =
        level === 1
          ? "text-3xl font-semibold tracking-tight"
          : level === 2
            ? "mt-10 text-2xl font-semibold tracking-tight"
            : "mt-8 text-xl font-semibold";
      if (level === 1) {
        html.push(
          `<h1 class="${cls}">${renderInline(escapeHtml(heading[2]))}</h1>`,
        );
      } else {
        const id = headingIds[headingIdx++] ?? slugifyHeading(heading[2]);
        html.push(
          `<h${level} id="${id}" class="group ${cls} scroll-mt-24">${renderInline(escapeHtml(heading[2]))}<a href="#${id}" aria-label="Link to this section" class="ml-2 font-normal text-zinc-400 opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100">#</a></h${level}>`,
        );
      }
      i++;
      continue;
    }

    // Blockquote: `> [!KIND]` callouts or plain quotes.
    if (trimmed.startsWith(">")) {
      const quote: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith(">")) {
        quote.push(lines[i].trim().replace(/^>\s?/, ""));
        i++;
      }
      const marker = quote[0]?.match(
        /^\[!(TIP|NOTE|WARNING|CAUTION|DANGER|IMPORTANT)\]\s*(.*)$/i,
      );
      if (marker) {
        const rest = marker[2]
          ? [marker[2], ...quote.slice(1)]
          : quote.slice(1);
        html.push(renderCallout(marker[1].toUpperCase(), rest));
      } else {
        html.push(
          `<blockquote class="my-4 border-l-2 border-zinc-300 pl-4 text-zinc-600 dark:border-zinc-700 dark:text-zinc-400">${quote.map((q) => `<p class="my-1.5 leading-7">${renderInline(escapeHtml(q))}</p>`).join("\n")}</blockquote>`,
        );
      }
      continue;
    }

    // Markdown table: header | separator | rows (scroll wrapper for wide tables).
    if (
      trimmed.startsWith("|") &&
      i + 1 < lines.length &&
      /^\|?[\s:|-]+\|?[\s:|.-]*$/.test(lines[i + 1].trim()) &&
      lines[i + 1].includes("-")
    ) {
      const splitRow = (row: string) =>
        row
          .trim()
          .replace(/^\||\|$/g, "")
          .split("|")
          .map((c) => c.trim());
      const header = splitRow(trimmed);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        rows.push(splitRow(lines[i].trim()));
        i++;
      }
      const th = header
        .map(
          (c) =>
            `<th class="border-b px-3 py-2 text-left font-semibold">${renderInline(escapeHtml(c))}</th>`,
        )
        .join("");
      const tb = rows
        .map(
          (r) =>
            `<tr>${r.map((c) => `<td class="border-b border-zinc-200 px-3 py-2 align-top dark:border-zinc-800">${renderInline(escapeHtml(c))}</td>`).join("")}</tr>`,
        )
        .join("");
      html.push(
        `<div data-wide-table class="my-4 overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800"><table class="w-full min-w-[560px] text-sm"><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table></div>`,
      );
      continue;
    }

    if (/^-\s+/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^-\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^-\s+/, ""));
        i++;
      }
      html.push(
        `<ul class="my-3 list-disc space-y-1 pl-6">${items.map((it) => `<li class="leading-7">${renderInline(escapeHtml(it))}</li>`).join("")}</ul>`,
      );
      continue;
    }

    if (/^\d+\.\s+/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^\d+\.\s+/, ""));
        i++;
      }
      html.push(
        `<ol class="my-3 list-decimal space-y-1 pl-6">${items.map((it) => `<li class="leading-7">${renderInline(escapeHtml(it))}</li>`).join("")}</ol>`,
      );
      continue;
    }

    // Paragraph: gather consecutive plain lines.
    const para: string[] = [trimmed];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^(#{1,3}\s+|-\s+|\d+\.\s+|\||>|@@DOCSFENCE-\d+@@$)/.test(
        lines[i].trim(),
      )
    ) {
      para.push(lines[i].trim());
      i++;
    }
    const joined = para.join(" ");
    html.push(
      `<p class="my-3 leading-7">${renderInline(escapeHtml(joined))}</p>`,
    );
  }

  return html
    .join("\n")
    .replace(
      /@@DOCSFENCE-(\d+)@@/g,
      (_, n: string) => fences[Number(n)]?.html ?? "",
    );
}
