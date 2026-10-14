import type { Attributes } from "@opentelemetry/api";

// Phase 18 tracing foundation: register Vercel-native OpenTelemetry once per
// server instance. Traces ship via the Vercel Trace Drain (Datadog
// Marketplace) — no agent, no per-route wiring.
//
// Failure policy: telemetry must never break startup or serving. Everything
// below is best-effort — any failure keeps the API on no-op observability.
export async function register() {
  try {
    // serviceName MUST match the Vercel project name so the Datadog
    // integration correlates drains with this service. DD_SERVICE wins when
    // set; otherwise fall back to the Vercel project default.
    const serviceName =
      process.env.DD_SERVICE?.trim() ||
      process.env.OTEL_SERVICE_NAME?.trim() ||
      "tubelens";
    // Unified tagging: merged over @vercel/otel's Vercel defaults
    // (deployment.environment.name, service.version, ...). Unset stays unset.
    const attributes: Attributes = {};
    const env = process.env.DD_ENV?.trim();
    if (env) {
      attributes["deployment.environment.name"] = env;
    }
    const version = process.env.DD_VERSION?.trim();
    if (version) {
      attributes["service.version"] = version;
    }
    const { registerOTel } = await import("@vercel/otel");
    registerOTel(
      Object.keys(attributes).length > 0
        ? { serviceName, attributes }
        : { serviceName },
    );
    // Route pipeline spans through the OTel provider so request/error hooks
    // record on real spans instead of the no-op default.
    const [{ setObservabilityProvider }, { otelObservabilityProvider }] =
      await Promise.all([
        import("./lib/observability"),
        import("./lib/tracing"),
      ]);
    setObservabilityProvider(otelObservabilityProvider);
  } catch {
    // Intentionally ignored — routes keep serving with no-op observability.
  }
}
