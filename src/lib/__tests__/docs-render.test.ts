import { describe, expect, test } from "bun:test";
import {
  extractHeadings,
  parseFrontmatter,
  readDocFile,
  renderMarkdown,
  sanitizeHref,
  slugToFile,
} from "../docs";

describe("docs renderer", () => {
  test("h2/h3 get stable ids matching extractHeadings", () => {
    const md =
      "# Title\n\n## The Sequence\n\n### Step one\n\n## The Sequence\n";
    const html = renderMarkdown(md);
    const headings = extractHeadings(md);
    expect(headings.map((h) => h.id)).toEqual([
      "the-sequence",
      "step-one",
      "the-sequence-1",
    ]);
    for (const h of headings) {
      expect(html).toContain(`id="${h.id}"`);
      expect(html).toContain(`href="#${h.id}"`);
    }
  });

  test("[!TIP]/[!WARNING] blockquotes become callouts", () => {
    const html = renderMarkdown(
      "> [!TIP]\n> Keep it cheap.\n\n> [!WARNING]\n> Back off.\n",
    );
    expect(html).toContain('data-callout="tip"');
    expect(html).toContain('data-callout="warning"');
    expect(html).toContain("Keep it cheap.");
  });

  test("plain blockquotes render as quotes", () => {
    const html = renderMarkdown("> Just a quote.\n");
    expect(html).toContain("<blockquote");
    expect(html).not.toContain("data-callout");
  });

  test("code blocks carry copy hooks and escaped content", () => {
    const html = renderMarkdown('```bash\ncurl "<x>"\n```');
    expect(html).toContain("data-code-block");
    expect(html).toContain("data-docs-copy");
    expect(html).toContain("curl &quot;&lt;x&gt;&quot;");
    expect(html).not.toContain("<x>");
  });

  test("raw html in prose is escaped, markdown links allowlisted", () => {
    const html = renderMarkdown(
      "<script>alert(1)</script>\n\n[Docs](/docs) and [evil](javascript:alert(1))",
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain('href="/docs"');
    expect(html).toContain('href="#"');
  });

  test("tables get a wide scroll wrapper", () => {
    const html = renderMarkdown("| A | B |\n| --- | --- |\n| 1 | 2 |\n");
    expect(html).toContain("data-wide-table");
    expect(html).toContain("<table");
  });
});

describe("docs link allowlist", () => {
  test("allows https, site paths, fragments", () => {
    expect(sanitizeHref("https://example.com/x")).toBe("https://example.com/x");
    expect(sanitizeHref("HTTP://EXAMPLE.COM")).toBe("HTTP://EXAMPLE.COM");
    expect(sanitizeHref("/docs/quickstart")).toBe("/docs/quickstart");
    expect(sanitizeHref("#the-sequence")).toBe("#the-sequence");
  });

  test("blocks protocol-relative and dangerous schemes", () => {
    for (const bad of [
      "//evil.com/phish",
      "///evil.com",
      "javascript:alert(1)",
      "JAVASCRIPT:alert(1)",
      "JaVaScRiPt:alert(1)",
      "data:text/html,<h1>x</h1>",
      "vbscript:msgbox(1)",
      "file:///etc/passwd",
    ]) {
      expect(sanitizeHref(bad)).toBe("#");
    }
  });

  test("rendered markdown never emits a dangerous href", () => {
    const html = renderMarkdown(
      "[a](//evil.com) [b](JAVASCRIPT:alert(1)) [c](data:text/html,x)",
    );
    expect(html).not.toContain("//evil.com");
    expect(html).not.toContain("javascript");
    expect(html).not.toContain("JAVASCRIPT");
    expect(html).not.toContain("data:text");
    expect(html.match(/href="#"/g)?.length).toBe(3);
  });
});

describe("docs file access", () => {
  test("missing files read as null (notFound, not 500)", () => {
    expect(readDocFile(["nope-missing"])).toBeNull();
  });

  test("traversal slugs resolve to null, incl. encoded forms", () => {
    for (const slug of [
      [".."],
      ["..", "secret"],
      ["%2e%2e"],
      ["%2E%2E%2Fsecret"],
      ["a%2fb"],
      ["a%5cb"],
      [""],
      ["."],
    ]) {
      expect(slugToFile(slug)).toBeNull();
      expect(readDocFile(slug)).toBeNull();
    }
  });
});

describe("docs frontmatter tolerance", () => {
  test("BOM + CRLF parse like plain LF", () => {
    const bom = String.fromCharCode(0xfeff);
    const raw = `${bom}---\r\ntitle: Hi\r\ndescription: Yo\r\n---\r\n\r\n# Hi\r\n`;
    const doc = parseFrontmatter(raw);
    expect(doc.title).toBe("Hi");
    expect(doc.description).toBe("Yo");
    expect(doc.body).toBe("# Hi");
  });
});
