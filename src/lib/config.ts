// Phase 01 platform boundary: config validation + dependency failure policy.
//
// Rule: security-critical missing config must fail safely (throw a typed
// ConfigError — never silently disable protection); optional observability
// config missing must degrade gracefully (no-op observability, API serves).

export const CONFIG_ERROR_CODE = "missing_security_config";

export class ConfigError extends Error {
  readonly code = CONFIG_ERROR_CODE;
  readonly status = 500;

  constructor(message: string, hint: string) {
    super(`${message} Hint: ${hint}`);
    this.name = "ConfigError";
  }
}

export type AuthEnforcement = "off" | "required";

export interface ObservabilityConfig {
  enabled: boolean;
  /** Why observability is disabled (e.g. which var is missing). */
  reason?: string;
}

export interface PlatformConfig {
  authEnforcement: AuthEnforcement;
  observability: ObservabilityConfig;
}

type Env = Record<string, string | undefined>;

/**
 * Validate platform config from the environment. Reads (never writes)
 * process.env by default; pass an explicit map in tests.
 *
 * - Optional observability (DATADOG_API_KEY / DD_API_KEY): missing → the
 *   API still serves with no-op observability.
 * - Security-critical auth (CLERK_SECRET_KEY): required only when
 *   TUBELENS_AUTH_ENFORCEMENT=required. Missing in that mode → throw
 *   ConfigError rather than silently serving unprotected.
 */
export function getConfig(env: Env = process.env): PlatformConfig {
  const datadogApiKey = env.DATADOG_API_KEY ?? env.DD_API_KEY;
  const observability: ObservabilityConfig = datadogApiKey
    ? { enabled: true }
    : { enabled: false, reason: "missing_datadog_api_key" };

  const rawEnforcement = env.TUBELENS_AUTH_ENFORCEMENT;
  if (
    rawEnforcement !== undefined &&
    rawEnforcement !== "off" &&
    rawEnforcement !== "required"
  ) {
    throw new ConfigError(
      "Unknown TUBELENS_AUTH_ENFORCEMENT value.",
      "Set TUBELENS_AUTH_ENFORCEMENT to off or required, or unset it.",
    );
  }
  const authEnforcement: AuthEnforcement =
    rawEnforcement === "required" ? "required" : "off";
  if (authEnforcement === "required" && !(env.CLERK_SECRET_KEY ?? "").trim()) {
    throw new ConfigError(
      "CLERK_SECRET_KEY is required when TUBELENS_AUTH_ENFORCEMENT=required.",
      "Set CLERK_SECRET_KEY in the deployment secret store; refusing to serve unprotected.",
    );
  }

  return { authEnforcement, observability };
}

/**
 * Fail-safe assertion for a security-critical secret: returns the value
 * when present, throws ConfigError when missing/blank. Use at startup or
 * request time anywhere protection must never be silently disabled.
 */
export function requireSecuritySecret(
  env: Env,
  name: string,
  hint: string,
): string {
  const value = env[name];
  if (!value || value.trim() === "") {
    throw new ConfigError(`${name} is required but missing or empty.`, hint);
  }
  return value;
}
