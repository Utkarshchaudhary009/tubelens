// Phase 11 (Part B): centralized secret redaction.
//
// Single choke point for keeping credentials out of logs, traces, error
// responses, and snapshots. Covers the inventoried secret kinds:
// `Authorization` / cookies, `ak_*` API keys, Clerk secrets,
// `TUNNEL_UPDATE_TOKEN`, `BLOB_READ_WRITE_TOKEN`, `DATABASE_URL` (+ direct),
// `SUPADATA_API_KEY`, Datadog keys, and generic secret/token/password shapes.
//
// Rules:
// - Key-based redaction (`redactHeaders`, `redactObject`) wins over value
//   sniffing wherever a key is available.
// - `scrubString` / `scrubError` are the free-text fallback for messages,
//   reasons, and thrown errors that may embed a secret without its key.
// - Telemetry/error paths must pass through here; nothing in this module
//   reads secrets — it only removes them.
//
// Dependency-free and `server-only`-free by design: safe to import from any
// layer, including the request pipeline and audit log.

/** Sentinel replacing every redacted value. Grep-able and value-free. */
export const REDACTED = "[REDACTED]";

/** Depth cap for recursive redaction: deeper structures collapse to REDACTED. */
const MAX_REDACT_DEPTH = 5;

/** Cause-chain cap for scrubbed errors: deeper causes collapse to REDACTED. */
const MAX_CAUSE_DEPTH = 3;

/**
 * Sensitive-key matcher. Keys are normalized (lowercased, `_`/`.`/`-` and
 * whitespace stripped) before matching so `X-Api-Key`, `x_api_key`, and
 * `xapikey` all hit. Over-redaction is the safe direction: an unknown
 * `*_token` field is treated as secret-bearing.
 */
const SENSITIVE_KEY_PATTERN =
  /authorization|cookie|setcookie|apikey|clerksecret|tunnelupdatetoken|blobreadwritetoken|database|supadata|datadog|secret|token|passwd|password/;

/** True when a header / object key may carry a secret. */
export function isSensitiveKey(key: string): boolean {
  if (typeof key !== "string") {
    return true;
  }
  return SENSITIVE_KEY_PATTERN.test(key.toLowerCase().replace(/[_.\-\s]/g, ""));
}

// Free-text value patterns: [secret-shape, replacement]. Written with regex
// syntax (character classes, groups) rather than example literals so this
// file's own source never matches the static secret scan.
const SCRUB_RULES: Array<[RegExp, string]> = [
  // postgres URL with userinfo (user:pass@). Port-only URLs (`host:5432/db`
  // with no `@`) do not match and are left intact.
  [/(postgres(?:ql)?):\/\/[^\s'"]*:[^\s'"]*@/g, `$1://${REDACTED}`],
  // Env-style assignments (`NAME=value`, `NAME: value`). Empty values and
  // placeholder values are left for the caller/scan to judge; runtime
  // scrubbing redacts any non-empty value.
  [
    /\b(DATABASE_URL|DATABASE_DIRECT_URL|CLERK_SECRET_KEY|TUNNEL_UPDATE_TOKEN|BLOB_READ_WRITE_TOKEN|TUBELENS_AUDIO_SECRET|SUPADATA_API_KEY|DATADOG_API_KEY|DD_API_KEY)\s*[:=]\s*['"]?[^\s'";,]+/g,
    `$1=${REDACTED}`,
  ],
  // Stripe-shaped test/live keys.
  [/\bsk_(?:live|test)_[A-Za-z0-9]{6,}/g, REDACTED],
  // Clerk-style machine keys (`ak_*`, test or live).
  [/\bak_[A-Za-z0-9_-]{8,}/g, REDACTED],
  // Bearer tokens. The trailing lookahead keeps `Bearer <name>=` prose
  // (e.g. `Bearer resource_metadata=`) intact while catching real tokens.
  [
    /\bBearer\s+[A-Za-z0-9._~+/-]{8,}(?![A-Za-z0-9._~+/-=])/g,
    `Bearer ${REDACTED}`,
  ],
  // Basic-auth credentials. The lookahead requires a digit or base64
  // symbol somewhere in the token so prose like `Basic authentication`
  // survives while real base64 credentials are redacted.
  [
    /\bBasic\s+(?=[A-Za-z0-9+/]*[0-9+/=])[A-Za-z0-9+/]{8,}={0,2}(?![A-Za-z0-9+/=])/g,
    `Basic ${REDACTED}`,
  ],
  // Serialized-JSON credential fields (`"authToken":"…"`, `"password":"…"`).
  // The field name and JSON structure survive; only the value is redacted.
  [
    /("(?:authToken|apiKey|api_key|accessToken|token|password|passwd|secret|clientSecret)")\s*:\s*"[^"]*"/g,
    `$1:"${REDACTED}"`,
  ],
];

/**
 * Redact secret-shaped values embedded in free text. Never throws; non-string
 * input yields REDACTED rather than leaking through unexamined.
 */
export function scrubString(input: string): string {
  if (typeof input !== "string") {
    return REDACTED;
  }
  let out = input;
  for (const [pattern, replacement] of SCRUB_RULES) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, replacement);
  }
  return out;
}

export type HeadersLike =
  | Headers
  | Record<string, string | string[] | undefined | null>
  | undefined
  | null;

/**
 * Redact request/response headers into a plain record safe for logs and
 * traces. Sensitive names (`authorization`, `cookie`, `set-cookie`,
 * `*api-key*`, `*secret*`, `*token*`, …) become `[REDACTED]`; every other
 * value still passes through `scrubString` in case a secret was pasted into
 * an innocuous header. Never throws — unusable input yields `{}`.
 */
export function redactHeaders(input: HeadersLike): Record<string, string> {
  const out: Record<string, string> = {};
  if (input === undefined || input === null) {
    return out;
  }
  try {
    if (input instanceof Headers) {
      for (const [name, value] of input.entries()) {
        out[name] = isSensitiveKey(name) ? REDACTED : scrubString(value);
      }
      return out;
    }
    if (typeof input === "object") {
      for (const [name, value] of Object.entries(input)) {
        if (value === undefined || value === null) {
          continue;
        }
        const joined = Array.isArray(value) ? value.join(", ") : String(value);
        out[name] = isSensitiveKey(name) ? REDACTED : scrubString(joined);
      }
      return out;
    }
  } catch {
    return {};
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Shared traversal state for `redactValue` / `scrubErrorInner` below. A
 * single seen-set and depth counter spans both functions so an
 * Error↔object cycle (object field points at an Error whose cause points
 * back at the object) terminates instead of ping-ponging with reset
 * budgets until the stack overflows.
 */
interface ScrubState {
  seen: WeakSet<object>;
  depth: number;
}

/**
 * Deep-clone `input` with secret-bearing content redacted: sensitive keys
 * become `[REDACTED]`, free-text strings are scrubbed, and structures deeper
 * than the cap (or circular) collapse to `[REDACTED]`. Dates pass through by
 * reference (no secret content); `Error` instances route to the shared
 * scrub worker (cycle-safe); other class instances become `[REDACTED]`.
 * Never throws — on any internal failure the safest answer (`[REDACTED]`)
 * is returned.
 */
export function redactObject<T>(input: T): T {
  try {
    return redactValue(input, { seen: new WeakSet(), depth: 0 }) as T;
  } catch {
    return REDACTED as T;
  }
}

function redactValue(value: unknown, state: ScrubState): unknown {
  if (typeof value === "string") {
    return scrubString(value);
  }
  if (
    value === null ||
    value === undefined ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return value;
  }
  if (typeof value === "function" || typeof value === "symbol") {
    return REDACTED;
  }
  if (typeof value !== "object") {
    return value;
  }
  if (value instanceof Date) {
    return value;
  }
  if (value instanceof Error) {
    // Cycle guard lives in scrubErrorInner (which owns Error traversal):
    // pre-adding here would make every Error look already-visited.
    return scrubErrorInner(value, state);
  }
  if (state.depth >= MAX_REDACT_DEPTH) {
    return REDACTED;
  }
  if (state.seen.has(value)) {
    return REDACTED;
  }
  const child: ScrubState = { seen: state.seen, depth: state.depth + 1 };
  if (Array.isArray(value)) {
    state.seen.add(value);
    return value.map((item) => redactValue(item, child));
  }
  if (!isPlainObject(value)) {
    return REDACTED;
  }
  state.seen.add(value);
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = isSensitiveKey(key) ? REDACTED : redactValue(entry, child);
  }
  return out;
}

/**
 * Scrub a thrown error for telemetry: same name, scrubbed message, scrubbed
 * `cause` chain (capped), and only safe scalar extras (`code` when a short
 * string, `status` when a number). The stack is intentionally dropped —
 * stacks can embed secret-bearing URLs and arguments, and the scrubbed
 * message plus request id are sufficient for triage. Non-Error values route
 * through `redactObject`; strings are scrubbed directly.
 */
export function scrubError(err: unknown, depth = 0): unknown {
  return scrubErrorInner(err, { seen: new WeakSet(), depth });
}

function scrubErrorInner(err: unknown, state: ScrubState): unknown {
  if (typeof err === "string") {
    return scrubString(err);
  }
  if (!(err instanceof Error)) {
    return redactValue(err, state);
  }
  if (state.seen.has(err)) {
    return REDACTED;
  }
  state.seen.add(err);
  const clean = new Error(scrubString(err.message));
  clean.name =
    typeof err.name === "string" && err.name !== "" ? err.name : "Error";
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && code.length > 0 && code.length <= 64) {
    (clean as { code?: string }).code = scrubString(code);
  }
  const status = (err as { status?: unknown }).status;
  if (typeof status === "number" && Number.isFinite(status)) {
    (clean as { status?: number }).status = status;
  }
  if (state.depth < MAX_CAUSE_DEPTH && err.cause !== undefined) {
    try {
      (clean as { cause?: unknown }).cause = scrubErrorInner(err.cause, {
        seen: state.seen,
        depth: state.depth + 1,
      });
    } catch {
      (clean as { cause?: unknown }).cause = REDACTED;
    }
  }
  return clean;
}

/** Strip `user:pass@` userinfo from a scheme authority (`scheme://…`). */
function stripUserinfo(authority: string): string {
  return authority.replace(/^([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/?#\s]*@/, "$1");
}

/** Redact `key=value` pairs with sensitive keys in a query/fragment string. */
function redactPairs(pairs: string): string {
  return pairs
    .split("&")
    .map((part) => {
      const eq = part.indexOf("=");
      if (eq === -1) {
        return part;
      }
      const key = part.slice(0, eq);
      let checkKey = key;
      try {
        checkKey = decodeURIComponent(key);
      } catch {
        // Undecodable keys redact conservatively rather than leaking
        // through unexamined; the original key text is preserved.
        return `${key}=${REDACTED}`;
      }
      return isSensitiveKey(checkKey) ? `${key}=${REDACTED}` : part;
    })
    .join("&");
}

/**
 * Redact a URL for logs and traces: userinfo (`user:pass@`) is stripped,
 * query and fragment params with sensitive names (`api_key`, `token`, …)
 * become `[REDACTED]`, and the remainder is scrubbed for embedded secret
 * shapes. Unparseable input is still scrubbed (never returned raw).
 */
export function redactUrl(raw: string): string {
  if (typeof raw !== "string") {
    return REDACTED;
  }
  if (raw === "") {
    return raw;
  }
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    const hashBody = url.hash.startsWith("#") ? url.hash.slice(1) : "";
    if (hashBody !== "") {
      const redactedHash = redactPairs(hashBody);
      if (redactedHash !== hashBody) {
        url.hash = `#${redactedHash}`;
      }
    }
    for (const key of [...url.searchParams.keys()]) {
      if (isSensitiveKey(key)) {
        url.searchParams.set(key, REDACTED);
      }
    }
    return scrubString(url.toString());
  } catch {
    const qmark = raw.indexOf("?");
    if (qmark === -1) {
      return scrubString(stripUserinfo(raw));
    }
    const base = stripUserinfo(raw.slice(0, qmark));
    return scrubString(`${base}?${redactPairs(raw.slice(qmark + 1))}`);
  }
}

// ---------------------------------------------------------------------------
// Static secret scan: the value-shape patterns CI and unit tests share.
// ---------------------------------------------------------------------------

/**
 * Committed-secret value shapes (non-global; safe for repeated `.test`).
 * Built with regex syntax so this file's own source never matches:
 * - credential-bearing database URLs (`scheme://user:pass@…`),
 * - Stripe-shaped `sk_live_*` / `sk_test_*` keys,
 * - Clerk-style `ak_*` machine keys,
 * - non-empty secret assignments (`DATABASE_URL=…`, `CLERK_SECRET_KEY: …`).
 *
 * Bare env *names* without values never match — reading
 * `process.env.X` or naming a key in prose is not a leak. Callers skip
 * placeholder/empty values (see `isPlaceholderLine`) and skip test
 * fixtures (intentionally fake secrets) so the scan stays signal-only.
 */
export const SECRET_SCAN_PATTERNS: readonly RegExp[] = [
  /postgres(?:ql)?:\/\/[^\s'"]*:[^\s'"]*@/,
  /\bsk_(?:live|test)_[A-Za-z0-9]{6,}/,
  /\bak_[A-Za-z0-9_-]{8,}/,
  /\b(DATABASE_URL|DATABASE_DIRECT_URL|CLERK_SECRET_KEY|TUNNEL_UPDATE_TOKEN|BLOB_READ_WRITE_TOKEN|TUBELENS_AUDIO_SECRET|SUPADATA_API_KEY|DATADOG_API_KEY|DD_API_KEY)\s*[:=]\s*['"]?[^\s'";,]+/,
];

/**
 * Placeholder markers that prove a matched line is documentation, not a
 * credential: template brackets (`<user>`), `YOUR_`-style template names,
 * standalone `USER`/`PASSWORD`/`HOST`/`example` words (word-boundaried, so
 * `dbuser`/`prodhost1`/`myexamplehost` in real credentials still match),
 * well-known placeholder words, ellipsis, and workflow secret references
 * (`${{ secrets.… }}`). Deliberately NOT matching `process.env` (an
 * assignment is an assignment — a `process.env` mention must not excuse a
 * committed value) and NOT word-matching test/fake/mock — committed
 * test-mode keys literally contain those substrings, so excluding them
 * would blind the scan; test *files* are excluded by path instead (see the
 * db.test.ts scan + CI job).
 */
export const PLACEHOLDER_PATTERN =
  /<|YOUR_|\b(USER|PASSWORD|HOST|example)\b|changeme|placeholder|\.\.\.|…|\$\{\{|secrets\.|\$\{[A-Z_][A-Z0-9_]*(?::-[^}]*)?\}/i;

/** True when a matched line is documentation/fixture noise, not a leak. */
export function isPlaceholderLine(line: string): boolean {
  return PLACEHOLDER_PATTERN.test(line);
}

/** True when free text contains any committed-secret value shape. */
export function containsLikelySecret(text: string): boolean {
  if (typeof text !== "string") {
    return false;
  }
  return SECRET_SCAN_PATTERNS.some((pattern) => pattern.test(text));
}
