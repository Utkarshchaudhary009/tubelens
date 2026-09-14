import type { NextRequest } from "next/server";
import { z } from "zod";
import { CACHE_CONTROL, getRequestId, successResponse } from "./envelope";
import { errorResponse } from "./errors";

// Throwaway tunnel pointers stored in Vercel Blob as `tunnel-url-<name>.json`
// (one blob per named slot). The GitHub Action publishes the current
// Cloudflare quick-tunnel URL here (POST/PUT with a bearer token); anyone can
// read it back (GET, no-store). `name` is always required — there is no
// default slot, so bare GET/POST without one is a 400, never a fallback.

/** Named tunnel slots. `t3` = T3 remote-dev pairing URL (the FULL
 * `/pair#token=` URL posted by the remote-t3 workflow — the fragment carries
 * the token so /dev/t3 can auto-pair); `transcript` = throwaway tts-test
 * helper (speak/transcript server published by the tts-tunnel-test workflow).
 * Slots are independent blobs; concurrent publishers to the SAME slot are
 * last-writer-wins (runId identifies the winner). */
export const tunnelSlotSchema = z.enum(["t3", "transcript"]);
export type TunnelSlot = z.infer<typeof tunnelSlotSchema>;

/** Blob pathname for a slot's tunnel pointer (overwritten every run). */
export function tunnelBlobPath(slot: TunnelSlot): string {
  return `tunnel-url-${slot}.json`;
}

/** Only free Cloudflare quick-tunnel URLs are accepted — never arbitrary hosts. */
const TUNNEL_URL_RE =
  /^https:\/\/[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.trycloudflare\.com(?::\d{1,5})?(?:\/.*)?$/;

export const tunnelUrlBodySchema = z.object({
  name: tunnelSlotSchema,
  url: z
    .string()
    .trim()
    .min(1, "url must not be empty.")
    .max(500, "url must be at most 500 characters.")
    .regex(TUNNEL_URL_RE, "url must be an https://*.trycloudflare.com URL."),
  runId: z.string().trim().min(1).max(200).optional(),
});

export interface TunnelRecord {
  url: string;
  runId: string;
  updatedAt: string;
}

const storedTunnelSchema = z.object({
  url: z.string().regex(TUNNEL_URL_RE),
  runId: z.string().default(""),
  updatedAt: z.string().min(1),
});

/** Lenient read-back: valid records pass through, anything else is "none". */
export function parseStoredTunnel(json: unknown): TunnelRecord | null {
  const parsed = storedTunnelSchema.safeParse(json);
  if (!parsed.success) {
    return null;
  }
  return {
    url: parsed.data.url,
    runId: parsed.data.runId,
    updatedAt: parsed.data.updatedAt,
  };
}

export interface TunnelStore {
  read: (slot: TunnelSlot) => Promise<TunnelRecord | null>;
  write: (slot: TunnelSlot, rec: TunnelRecord) => Promise<TunnelRecord>;
}

export interface TunnelDeps {
  store: TunnelStore;
  expectedToken: string | undefined;
}

/** Constant-time-ish bearer comparison; false when no token is configured. */
export function isAuthorized(
  authHeader: string | null,
  expectedToken: string | undefined,
): boolean {
  if (!expectedToken || !authHeader) {
    return false;
  }
  const match = /^Bearer\s+(\S+)\s*$/.exec(authHeader);
  if (!match) {
    return false;
  }
  const token = match[1];
  if (token.length !== expectedToken.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < token.length; i++) {
    diff |= token.charCodeAt(i) ^ expectedToken.charCodeAt(i);
  }
  return diff === 0;
}

export async function handleTunnelGet(req: NextRequest, deps: TunnelDeps) {
  const requestId = getRequestId(req);
  const slot = resolveSlot(req.nextUrl.searchParams.get("name"));
  if (!slot.ok) {
    return errorResponse(requestId, slot.error);
  }
  try {
    const rec = await deps.store.read(slot.slot);
    return successResponse(rec, {
      requestId,
      cacheControl: CACHE_CONTROL.noStore,
    });
  } catch {
    return errorResponse(requestId, {
      code: "upstream_degraded",
      message: "Could not read the stored tunnel URL.",
      hint: "Retry shortly; include X-Request-Id in bug reports.",
      status: 502,
    });
  }
}

/** Validate the required `name` slot: missing/blank → 400 missing_name,
 * unknown value → 400 invalid_name. There is intentionally no default slot. */
function resolveSlot(
  raw: unknown,
  hint = "Pass ?name=t3 or ?name=transcript — e.g. GET /api/v1/tunnel-url?name=t3.",
):
  | { ok: true; slot: TunnelSlot }
  | {
      ok: false;
      error: { code: string; message: string; hint: string; status: number };
    } {
  if (typeof raw !== "string" || raw.trim() === "") {
    return {
      ok: false,
      error: {
        code: "missing_name",
        message: "Query/body `name` is required.",
        hint,
        status: 400,
      },
    };
  }
  const parsed = tunnelSlotSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        code: "invalid_name",
        message: `Unknown tunnel slot ${JSON.stringify(raw)}.`,
        hint,
        status: 400,
      },
    };
  }
  return { ok: true, slot: parsed.data };
}

export async function handleTunnelWrite(req: NextRequest, deps: TunnelDeps) {
  const requestId = getRequestId(req);
  if (!isAuthorized(req.headers.get("authorization"), deps.expectedToken)) {
    return errorResponse(requestId, {
      code: "unauthorized",
      message: "Missing or invalid bearer token.",
      hint: "Send Authorization: Bearer <TUNNEL_UPDATE_TOKEN> with the request.",
      status: 401,
    });
  }
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return errorResponse(requestId, {
      code: "invalid_body",
      message: "Request body must be valid JSON.",
      hint: 'Send JSON like {"name": "t3", "url": "https://<name>.trycloudflare.com", "runId": "123"} with Content-Type: application/json.',
      status: 400,
    });
  }
  // `name` is required with no default: prefer the body field, accept the
  // ?name= query param as an alternative. Missing → 400 missing_name,
  // unknown value → 400 invalid_name.
  const bodyName =
    typeof raw === "object" && raw !== null && "name" in raw
      ? (raw as { name: unknown }).name
      : undefined;
  const slot = resolveSlot(
    bodyName === undefined ? req.nextUrl.searchParams.get("name") : bodyName,
    "Send {name: 't3'} or {name: 'transcript'} in the JSON body (or ?name=t3 / ?name=transcript) — those are the only tunnel slots.",
  );
  if (!slot.ok) {
    return errorResponse(requestId, slot.error);
  }
  const parsed = tunnelUrlBodySchema.omit({ name: true }).safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const isUrl = first?.path[0] === "url";
    return errorResponse(requestId, {
      code: isUrl ? "invalid_tunnel_url" : "invalid_body",
      message: first?.message ?? "Request body is invalid.",
      hint: 'Send JSON like {"name": "t3", "url": "https://<name>.trycloudflare.com", "runId": "123"} — url must be an https quick-tunnel URL.',
      status: 400,
    });
  }
  try {
    const saved = await deps.store.write(slot.slot, {
      url: parsed.data.url,
      runId: parsed.data.runId ?? "",
      updatedAt: new Date().toISOString(),
    });
    return successResponse(saved, {
      requestId,
      cacheControl: CACHE_CONTROL.noStore,
    });
  } catch {
    return errorResponse(requestId, {
      code: "upstream_degraded",
      message: "Could not store the tunnel URL.",
      hint: "Verify the Vercel Blob store is connected (BLOB_READ_WRITE_TOKEN) and retry.",
      status: 502,
    });
  }
}
