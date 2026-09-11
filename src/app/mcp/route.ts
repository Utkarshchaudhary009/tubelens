import type { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "mcp-handler";
import { NextRequest } from "next/server";
import { z } from "zod";
import { handleSearch, type SearchDeps } from "@/app/api/v1/search/route";
import { handleGetVideo, type VideoDeps } from "@/app/api/v1/videos/[id]/route";
import {
  isPlausibleVideoId,
  parseLang,
  parseRegion,
  searchTypeSchema,
} from "@/lib/validate";

export const runtime = "nodejs";

// M0 MCP spike: exactly 2 read-only tools reusing the REST service path.
// No mapping logic is duplicated here — each tool builds a NextRequest and
// delegates to the same handleSearch/handleGetVideo the REST routes use, so
// cache keys, TTLs, fail-fast timeouts, cursors, and envelopes are identical.

const SERVER_NAME = "tubelens";
const SERVER_VERSION = "0.1.0";

const searchInputSchema = z.object({
  q: z.string().optional(),
  type: searchTypeSchema.optional().default("all"),
  /**
   * Integers delegate to the REST search path, which clamps to [1, 50].
   * Floats fail here at the schema boundary (REST limits are integers).
   */
  limit: z.number().int().optional(),
  region: z.string().optional().default("US"),
  lang: z.string().optional().default("en"),
  cursor: z.string().optional(),
});

export type SearchToolInput = z.input<typeof searchInputSchema>;
type SearchToolArgs = z.output<typeof searchInputSchema>;

const videoInputSchema = z.object({
  id: z.string().optional(),
  region: z.string().optional().default("US"),
  lang: z.string().optional().default("en"),
});

export type VideoToolInput = z.input<typeof videoInputSchema>;
type VideoToolArgs = z.output<typeof videoInputSchema>;

type ToolText = {
  content: [{ type: "text"; text: string }];
  isError?: true;
};

function toolText(body: unknown, isError: boolean): ToolText {
  const out: ToolText = {
    content: [{ type: "text", text: JSON.stringify(body) }],
  };
  if (isError) {
    out.isError = true;
  }
  return out;
}

function toolError(code: string, message: string, hint: string): ToolText {
  return toolText({ error: { code, message, hint, status: 400 } }, true);
}

/** Schema-boundary failure (SDK already validates; this covers direct calls). */
function schemaError(error: z.ZodError): ToolText {
  const issue = error.issues[0];
  const where = issue && issue.path.length > 0 ? issue.path.join(".") : "input";
  return toolError(
    "invalid_params",
    `Invalid ${where}: ${issue?.message ?? "invalid value"}.`,
    "Check the tool input schema — search takes {q, type, limit, region, lang, cursor}, get_video takes {id, region, lang}.",
  );
}

/** Mint a request id so the envelope's meta.requestId mirrors X-Request-Id. */
function mcpRequest(url: string): NextRequest {
  return new NextRequest(url, {
    headers: { "x-request-id": crypto.randomUUID() },
  });
}

export async function callSearchTool(
  rawArgs: SearchToolInput,
  deps?: SearchDeps,
): Promise<ToolText> {
  const parsed = searchInputSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return schemaError(parsed.error);
  }
  const args: SearchToolArgs = parsed.data;
  const q = (args.q ?? "").trim();
  if (!q && !args.cursor) {
    // Same code/message as GET /api/v1/search missing q; hint is tool-shaped.
    return toolError(
      "missing_query",
      "Query parameter q is required.",
      'Pass q, e.g. {"q": "lofi"}, or a cursor from a previous search page.',
    );
  }
  const params = new URLSearchParams();
  if (q) {
    params.set("q", q);
  }
  params.set("type", args.type);
  if (args.limit !== undefined) {
    params.set("limit", String(args.limit));
  }
  params.set("region", parseRegion(args.region));
  params.set("lang", parseLang(args.lang));
  if (args.cursor) {
    params.set("cursor", args.cursor);
  }
  const res = await handleSearch(
    mcpRequest(`https://tubelens.local/mcp/search?${params}`),
    deps,
  );
  return toolText(await res.json(), res.status >= 400);
}

export async function callGetVideoTool(
  rawArgs: VideoToolInput,
  deps?: VideoDeps,
): Promise<ToolText> {
  const parsed = videoInputSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return schemaError(parsed.error);
  }
  const args: VideoToolArgs = parsed.data;
  const id = (args.id ?? "").trim();
  if (!isPlausibleVideoId(id)) {
    // Same code/message as GET /api/v1/videos/{id}; hint is tool-shaped.
    return toolError(
      "invalid_video_id",
      "Invalid video id.",
      'Use an 11-character YouTube video id, e.g. {"id": "dQw4w9WgXcQ"}.',
    );
  }
  const params = new URLSearchParams({
    region: parseRegion(args.region),
    lang: parseLang(args.lang),
  });
  const res = await handleGetVideo(
    mcpRequest(`https://tubelens.local/mcp/videos/${id}?${params}`),
    id,
    deps,
  );
  return toolText(await res.json(), res.status >= 400);
}

export interface McpToolDeps {
  search?: SearchDeps;
  video?: VideoDeps;
}

export function registerTubelensTools(
  server: McpServer,
  deps: McpToolDeps = {},
): void {
  server.registerTool(
    "search",
    {
      description:
        "Search YouTube videos, channels, and playlists. Returns the same {data, page, meta, warnings} envelope as GET /api/v1/search. Page with the opaque cursor in page.next (unknown/expired cursors yield an empty page, never an error).",
      inputSchema: searchInputSchema,
    },
    async (args) => callSearchTool(args, deps.search),
  );
  server.registerTool(
    "get_video",
    {
      description:
        "Get metadata for a YouTube video by id. Returns the same {data, page, meta, warnings} envelope as GET /api/v1/videos/{id}.",
      inputSchema: videoInputSchema,
    },
    async (args) => callGetVideoTool(args, deps.video),
  );
}

/** Handler factory — tests inject mock deps; the route uses real upstream. */
export function buildMcpHandler(deps: McpToolDeps = {}) {
  return createMcpHandler((server) => registerTubelensTools(server, deps), {
    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
  });
}

const handler = buildMcpHandler();

export { handler as GET, handler as POST };
