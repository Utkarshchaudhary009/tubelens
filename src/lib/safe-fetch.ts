// Part B Phase 10 — SSRF-safe outbound fetch client.
//
// Single choke point for every server-side fetch to a partially-trusted
// destination (third-party crowd APIs, transcript providers, deciphered audio
// URLs, batch fan-out, tunnel blob reads). `resolve?url=` stays a pure
// classifier and never fetches — keep it that way.
//
// Pure module (no `import "server-only"`): like src/lib/authorize.ts it holds
// no secrets, and every lib consumer (community, audio, transcript-providers,
// utils) must stay importable under bun:test, where `server-only` throws. The
// server-only boundary lives at the Route Handlers.
//
// Always-on boundary per request:
// - https only, except http loopback when `allowLoopback` opts in (batch
//   local-dev origins only);
// - IP-literal tricks (decimal / octal / hex / mixed, percent-encoded,
//   trailing-dot / whitespace) canonicalized BEFORE the block check (WHATWG
//   URL already normalizes most of these; the decoder below is defense in
//   depth for runtimes that do not);
// - loopback, RFC1918 private, link-local, CGNAT, multicast/reserved, and
//   cloud metadata destinations rejected before any socket opens;
// - destination hostname must match `allowHosts` (exact, leading-dot suffix,
//   or RegExp — hosts are lowercased before matching);
// - redirects are followed manually (`redirect: "manual"`, at most
//   `maxRedirects` hops) with EVERY hop re-validated — protocol downgrades
//   and cross-origin escapes throw `SsrfBlockedError` without fetching;
// - error messages carry a reason category only, never the URL (credentials,
//   query, and path are never logged or surfaced).
//
// - URLs carrying userinfo (username/password) are rejected outright —
//   credentials must never ride an outbound fetch;
// - DNS pinning on every non-literal hop via node:dns (default; overridable
//   with `resolveFn`, skippable with `resolveFn: null` for injected test
//   transports): raced against the hop's composed budget signal, so a
//   stalled resolver cannot exceed it; a hostname resolving to a blocked IP
//   — or failing to resolve at all — throws before any socket opens;

import { lookup } from "node:dns/promises";

export class SsrfBlockedError extends Error {
  readonly code = "ssrf_blocked" as const;

  constructor(reason: string) {
    // Reason category only — never the URL (it may carry credentials).
    super(`Outbound request rejected by the SSRF filter (${reason}).`);
    this.name = "SsrfBlockedError";
  }
}

/** Minimal response shape safeFetch accepts and returns (real Response
 * satisfies it, so the default global fetch needs no adapter). */
export interface SafeFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export type SafeFetchFn = (
  input: string,
  init?: RequestInit,
) => Promise<SafeFetchResponse>;

/**
 * DNS lookup: hostname -> resolved IP strings. Receives the hop's composed
 * abort signal; resolvers should stop work when it fires (extra parameters
 * are optional, so existing single-arg stubs keep working).
 */
export type ResolveFn = (
  hostname: string,
  signal?: AbortSignal,
) => Promise<string[]>;

export interface SafeFetchOptions {
  /** Pinned destination hosts: exact (case-insensitive), leading-dot suffix
   * (".example.com" matches "example.com" + subdomains), or RegExp. */
  allowHosts: (string | RegExp)[];
  /** Permit loopback literals/names (+ http for those only). Batch local-dev
   * origins only — default false. */
  allowLoopback?: boolean;
  /** Per-hop fail-fast budget (default 8000, matching the route checklist).
   * Bounds the whole hop: DNS validation first, then the fetch. */
  timeoutMs?: number;
  /** Max redirect hops followed (default 3); exceeding throws. */
  maxRedirects?: number;
  method?: string;
  headers?: HeadersInit;
  body?: BodyInit | null;
  cache?: RequestCache;
  /** Extra abort source (e.g. the batch shared deadline). */
  signal?: AbortSignal;
  /** Injectable transport for tests (default global fetch). */
  fetchFn?: SafeFetchFn;
  /** Injectable DNS lookup: hostname -> resolved IP strings. `undefined`
   * (default) uses node:dns/promises `lookup` (fail closed on error);
   * pass `null` to skip DNS validation (injected test transports only —
   * production callers must not skip). */
  resolveFn?: ResolveFn | null;
}

// ---------------------------------------------------------------------------
// Host normalization + IP-literal decoding
// ---------------------------------------------------------------------------

/** Lowercase, strip IPv6 brackets, unwrap percent-encoding (up to 3 layers),
 * strip IPv6 zone ids, drop trailing dots. Returns "" when undecodable. */
function normalizeHost(raw: string): string {
  let host = raw.trim().toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) {
    host = host.slice(1, -1);
  }
  for (let i = 0; i < 3 && host.includes("%"); i += 1) {
    try {
      const decoded = decodeURIComponent(host);
      if (decoded === host) {
        break;
      }
      host = decoded.trim().toLowerCase();
    } catch {
      return "";
    }
  }
  // IPv6 zone ids (fe80::1%eth0) are never legitimate server-side.
  const zone = host.indexOf("%");
  if (zone !== -1) {
    host = host.slice(0, zone);
  }
  while (host.endsWith(".") && host.length > 1) {
    host = host.slice(0, -1);
  }
  return host;
}

function hasControlOrWhitespace(host: string): boolean {
  // No regex control escapes (biome noControlCharactersInRegex): any code
  // point at or below space, plus DEL, fails the hostname closed.
  for (const ch of host) {
    const code = ch.codePointAt(0) ?? 0;
    if (code <= 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

/**
 * inet_aton-style IPv4 literal parse: dotted decimal plus the classic
 * evasion forms — 0-prefixed octal (0177.0.0.1), 0x-prefixed hex
 * (0x7f.0.0.1), bare decimal (2130706433), and mixed widths (1-4 parts).
 * Returns the 4 canonical octets, or null when not a numeric literal.
 */
export function parseIPv4Literal(host: string): number[] | null {
  if (host === "" || host.includes(":")) {
    return null;
  }
  const parts = host.split(".");
  if (parts.length < 1 || parts.length > 4) {
    return null;
  }
  const nums: number[] = [];
  for (const part of parts) {
    if (part === "") {
      return null;
    }
    let v: number;
    if (/^0[xX][0-9a-fA-F]+$/.test(part)) {
      v = Number.parseInt(part, 16);
    } else if (/^0[0-9]+$/.test(part)) {
      // Leading-zero part: octal only when every digit is 0-7, so "09"
      // stays non-literal (WHATWG reads it decimal; the allowlist still
      // blocks it either way).
      if (!/^0[0-7]*$/.test(part)) {
        return null;
      }
      v = Number.parseInt(part, 8);
    } else if (/^[0-9]+$/.test(part)) {
      v = Number.parseInt(part, 10);
    } else {
      return null;
    }
    if (!Number.isSafeInteger(v) || v < 0) {
      return null;
    }
    nums.push(v);
  }
  const n0 = nums[0] as number;
  if (nums.length === 1) {
    if (n0 > 0xffffffff) {
      return null;
    }
    return [(n0 >>> 24) & 255, (n0 >>> 16) & 255, (n0 >>> 8) & 255, n0 & 255];
  }
  if (nums.length === 2) {
    const n1 = nums[1] as number;
    if (n0 > 0xff || n1 > 0xffffff) {
      return null;
    }
    return [n0, (n1 >>> 16) & 255, (n1 >>> 8) & 255, n1 & 255];
  }
  if (nums.length === 3) {
    const n1 = nums[1] as number;
    const n2 = nums[2] as number;
    if (n0 > 0xff || n1 > 0xff || n2 > 0xffff) {
      return null;
    }
    return [n0, n1, (n2 >>> 8) & 255, n2 & 255];
  }
  for (const n of nums) {
    if (n > 0xff) {
      return null;
    }
  }
  return nums;
}

/**
 * IPv6 literal parse (no brackets, no zone) into 16 bytes. Handles "::"
 * compression and an embedded dotted-quad tail (::ffff:127.0.0.1). Returns
 * null when not valid IPv6.
 */
export function parseIPv6Literal(host: string): number[] | null {
  if (!host.includes(":")) {
    return null;
  }
  const halves = host.split("::");
  if (halves.length > 2) {
    return null;
  }
  const parseSide = (side: string): number[] | null => {
    if (side === "") {
      return [];
    }
    const groups = side.split(":");
    const out: number[] = [];
    for (let i = 0; i < groups.length; i += 1) {
      const g = groups[i] as string;
      if (g.includes(".")) {
        // Dotted-quad tail is only valid as the final group.
        if (i !== groups.length - 1) {
          return null;
        }
        const v4 = parseIPv4Literal(g);
        if (!v4 || v4.length !== 4) {
          return null;
        }
        out.push(
          (((v4[0] as number) << 8) | (v4[1] as number)) & 0xffff,
          (((v4[2] as number) << 8) | (v4[3] as number)) & 0xffff,
        );
      } else {
        if (!/^[0-9a-fA-F]{1,4}$/.test(g)) {
          return null;
        }
        out.push(Number.parseInt(g, 16));
      }
    }
    return out;
  };
  const left = parseSide(halves[0] ?? "");
  const right = halves.length === 2 ? parseSide(halves[1] ?? "") : [];
  if (!left || !right) {
    return null;
  }
  let groups: number[];
  if (halves.length === 1) {
    if (left.length !== 8) {
      return null;
    }
    groups = left;
  } else {
    const total = left.length + right.length;
    if (total >= 8) {
      return null;
    }
    groups = [...left, ...new Array(8 - total).fill(0), ...right];
  }
  const bytes: number[] = [];
  for (const g of groups) {
    bytes.push((g >>> 8) & 255, g & 255);
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// Block classification
// ---------------------------------------------------------------------------

export interface BlockCheckOptions {
  allowLoopback?: boolean;
}

function blockedIPv4Reason(
  octets: number[],
  opts: BlockCheckOptions,
): string | null {
  const a = octets[0] as number;
  const b = octets[1] as number;
  const c = octets[2] as number;
  if (a === 0) {
    return "unspecified address";
  }
  if (a === 10) {
    return "private address";
  }
  if (a === 100 && b >= 64 && b <= 127) {
    return "shared address space";
  }
  if (a === 127) {
    return opts.allowLoopback ? null : "loopback address";
  }
  if (a === 169 && b === 254) {
    return "link-local address";
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return "private address";
  }
  if (a === 192 && b === 168) {
    return "private address";
  }
  if (a === 192 && (b === 0 || b === 2)) {
    return "reserved address";
  }
  if (a === 192 && b === 88 && c === 99) {
    return "reserved address";
  }
  if (a === 198 && (b === 18 || b === 19)) {
    return "benchmarking address";
  }
  if (a === 198 && b === 51 && c === 100) {
    return "documentation address";
  }
  if (a === 203 && b === 0 && c === 113) {
    return "documentation address";
  }
  if (a >= 224) {
    return a >= 240 ? "reserved address" : "multicast address";
  }
  return null;
}

function blockedIPv6Reason(
  bytes: number[],
  opts: BlockCheckOptions,
): string | null {
  if (bytes.every((v) => v === 0)) {
    return "unspecified address";
  }
  if (bytes.slice(0, 15).every((v) => v === 0) && bytes[15] === 1) {
    return opts.allowLoopback ? null : "loopback address";
  }
  // IPv4-mapped (::ffff:0:0/96): judge the embedded IPv4 address.
  if (
    bytes.slice(0, 10).every((v) => v === 0) &&
    bytes[10] === 0xff &&
    bytes[11] === 0xff
  ) {
    return blockedIPv4Reason(bytes.slice(12, 16), opts);
  }
  // 6to4 (2002::/16): judge the embedded IPv4 address.
  if (bytes[0] === 0x20 && bytes[1] === 0x02) {
    return blockedIPv4Reason(bytes.slice(2, 6), opts);
  }
  // Link-local fe80::/10.
  if (bytes[0] === 0xfe && ((bytes[1] as number) & 0xc0) === 0x80) {
    return "link-local address";
  }
  // Unique-local fc00::/7.
  if (((bytes[0] as number) & 0xfe) === 0xfc) {
    return "unique-local address";
  }
  // Multicast ff00::/8.
  if (bytes[0] === 0xff) {
    return "multicast address";
  }
  return null;
}

/** Cloud metadata + localhost aliases that must never be fetched. The IP
 * strings below are belt-and-braces (the range checks already cover them);
 * the names are the actual SSRF targets (GCE, Alibaba Cloud). */
const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
  "metadata.google",
  "instance-data",
  "169.254.169.254",
  "100.100.100.200",
]);

function blockedHostnameReason(
  host: string,
  opts: BlockCheckOptions,
): string | null {
  if (BLOCKED_HOSTNAMES.has(host)) {
    if (
      opts.allowLoopback &&
      (host === "localhost" || host === "localhost.localdomain")
    ) {
      return null;
    }
    return "blocked hostname";
  }
  if (host === "localhost" || host.endsWith(".localhost")) {
    return opts.allowLoopback ? null : "loopback hostname";
  }
  return null;
}

/**
 * True when the input (IP literal in any encoding, or hostname) must never
 * be fetched. Fail-closed: empty, control/whitespace-bearing, and malformed
 * IPv6-ish inputs all count as blocked.
 */
export function isBlockedAddress(
  input: string,
  opts: BlockCheckOptions = {},
): boolean {
  const host = normalizeHost(input);
  if (host === "" || hasControlOrWhitespace(host)) {
    return true;
  }
  const v4 = parseIPv4Literal(host);
  if (v4) {
    return blockedIPv4Reason(v4, opts) !== null;
  }
  if (host.includes(":")) {
    const v6 = parseIPv6Literal(host);
    if (!v6) {
      return true;
    }
    return blockedIPv6Reason(v6, opts) !== null;
  }
  return blockedHostnameReason(host, opts) !== null;
}

/**
 * True for loopback destinations (localhost names, 127/8, ::1) — the only
 * hosts http is ever allowed for, and only with `allowLoopback`.
 */
export function isLoopbackHost(input: string): boolean {
  const host = normalizeHost(input);
  if (host === "") {
    return false;
  }
  if (
    host === "localhost" ||
    host === "localhost.localdomain" ||
    host.endsWith(".localhost")
  ) {
    return true;
  }
  const v4 = parseIPv4Literal(host);
  if (v4) {
    return v4[0] === 127;
  }
  if (host.includes(":")) {
    const v6 = parseIPv6Literal(host);
    return !!v6 && v6.slice(0, 15).every((v) => v === 0) && v6[15] === 1;
  }
  return false;
}

/**
 * Allowlist match on an already-normalized host: exact (case-insensitive),
 * leading-dot suffix (".example.com" matches "example.com" + subdomains),
 * or RegExp (tested against the lowercased host).
 */
export function isAllowedHost(
  host: string,
  allowHosts: (string | RegExp)[],
): boolean {
  const h = host.toLowerCase();
  return allowHosts.some((entry) => {
    if (typeof entry === "string") {
      const e = entry.toLowerCase().replace(/\.$/, "");
      if (e.startsWith(".")) {
        const base = e.slice(1);
        return h === base || h.endsWith(e);
      }
      return h === e;
    }
    return entry.test(h);
  });
}

// ---------------------------------------------------------------------------
// Per-hop validation + redirect-following fetch
// ---------------------------------------------------------------------------

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

/**
 * Default DNS pinning (node:dns/promises). Exported so routes with explicit
 * transport wiring can pass it through; safeFetch uses it whenever
 * `resolveFn` is left `undefined`.
 */
export async function dnsResolve(
  hostname: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const records = await resolveWithSignal(
    lookup(hostname, { all: true }),
    signal,
  );
  return records.map((r) => r.address);
}

/** Races a task against an abort signal (node:dns has no signal hook). */
function resolveWithSignal<T>(
  task: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) {
    return task;
  }
  if (signal.aborted) {
    return Promise.reject(abortError());
  }
  let onAbort: (() => void) | undefined;
  const gate = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
  });
  return Promise.race([task, gate]).finally(() => {
    if (onAbort) {
      signal.removeEventListener("abort", onAbort);
    }
  });
}

function abortError(): Error {
  return Object.assign(new Error("DNS lookup aborted (hop budget)"), {
    name: "AbortError",
  });
}

async function checkUrl(
  raw: string,
  opts: SafeFetchOptions,
  signal?: AbortSignal,
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SsrfBlockedError("unparseable URL");
  }
  // Credentials must never ride an outbound fetch (checked per hop, so a
  // redirect cannot smuggle userinfo in either). Reason-only message: the
  // URL itself is never surfaced.
  if (url.username !== "" || url.password !== "") {
    throw new SsrfBlockedError("credentialed URL");
  }
  const allowLoopback = opts.allowLoopback === true;
  const host = normalizeHost(url.hostname);
  if (host === "" || hasControlOrWhitespace(host)) {
    throw new SsrfBlockedError("invalid hostname");
  }
  // Protocol gate: https only, except http loopback when opted in.
  if (url.protocol !== "https:") {
    if (!(allowLoopback && url.protocol === "http:" && isLoopbackHost(host))) {
      throw new SsrfBlockedError("protocol not allowed");
    }
  }
  if (isBlockedAddress(host, { allowLoopback })) {
    throw new SsrfBlockedError("blocked destination");
  }
  if (!isAllowedHost(host, opts.allowHosts)) {
    throw new SsrfBlockedError("destination not allowlisted");
  }
  // DNS pinning (skipped for IP literals — already validated above — and
  // for `resolveFn: null` test transports). Default is a real node:dns
  // lookup raced against the hop's composed signal, so a stalled resolver
  // cannot exceed the per-hop budget or an outer shared deadline; any
  // failure fails closed since the destination is unverifiable.
  // NOTE (residual TOCTOU): the validated address is not pinned to the
  // connection — global fetch performs its own lookup. Connection-level
  // pinning (custom dispatcher/connect hook) was deemed disproportionate:
  // prod hostnames are fixed allowlist entries or our own origin.
  const isLiteral = parseIPv4Literal(host) !== null || host.includes(":");
  if (!isLiteral && opts.resolveFn !== null) {
    const resolve = opts.resolveFn ?? dnsResolve;
    let addrs: string[];
    try {
      addrs = await resolveWithSignal(resolve(host, signal), signal);
    } catch {
      // Unverifiable destination: fail closed.
      throw new SsrfBlockedError("destination unverifiable");
    }
    if (!Array.isArray(addrs) || addrs.length === 0) {
      throw new SsrfBlockedError("destination unverifiable");
    }
    for (const addr of addrs) {
      if (
        typeof addr !== "string" ||
        isBlockedAddress(addr, { allowLoopback })
      ) {
        throw new SsrfBlockedError("blocked destination");
      }
    }
  }
  return url;
}

/**
 * Fetch through the SSRF boundary. Every redirect hop re-runs ALL checks
 * (protocol, literal/hostname blocks, allowlist, DNS pinning), so a
 * protocol downgrade or cross-origin Location throws `SsrfBlockedError`
 * WITHOUT fetching the target. Exceeding `maxRedirects` throws too.
 */
export async function safeFetch(
  rawUrl: string,
  opts: SafeFetchOptions,
): Promise<SafeFetchResponse> {
  const timeoutMs = opts.timeoutMs ?? 8000;
  const maxRedirects = opts.maxRedirects ?? 3;
  let current = rawUrl;
  let method = (opts.method ?? "GET").toUpperCase();
  let body = opts.body ?? undefined;
  // Bounded hop loop (maxRedirects + 1 fetches max): provably terminating,
  // no unbounded redirect chasing. The per-hop timeout is created BEFORE
  // validation so DNS stalling counts against the same budget as the fetch;
  // it resets every hop (redirect chains re-spend it) while an outer
  // opts.signal spans the whole chain.
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = opts.signal
      ? AbortSignal.any([timeout, opts.signal])
      : timeout;
    const url = await checkUrl(current, opts, signal);
    const fetchFn = opts.fetchFn ?? globalThis.fetch;
    const res = await fetchFn(url.href, {
      method,
      headers: opts.headers,
      body,
      cache: opts.cache,
      redirect: "manual",
      signal,
    });
    const location = res.headers.get("location");
    if (!REDIRECT_STATUS.has(res.status) || !location) {
      return res;
    }
    if (hop >= maxRedirects) {
      throw new SsrfBlockedError("too many redirects");
    }
    let next: URL;
    try {
      next = new URL(location, url.href);
    } catch {
      // Unfollowable Location: return the redirect as-is (callers treat
      // non-ok as an upstream error; nothing more is fetched).
      return res;
    }
    current = next.href;
    // 303 always, and 301/302 for POST, convert to GET (drop the body).
    if (
      res.status === 303 ||
      ((res.status === 301 || res.status === 302) && method === "POST")
    ) {
      method = "GET";
      body = undefined;
    }
  }
  throw new SsrfBlockedError("too many redirects");
}
