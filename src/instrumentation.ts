import type { Attributes } from "@opentelemetry/api";

// Phase 18 tracing foundation: register Vercel-native OpenTelemetry once per
// server instance. No agent, no per-route wiring.
//
// Delivery (chosen automatically by @vercel/otel, no code change):
// - Pro/Enterprise: Vercel Trace Drain (Marketplace Datadog integration).
//   Drains are NOT available on Hobby, so Hobby deployments use:
// - Hobby ($0): direct OTLP/HTTP from the function to Datadog's intake —
//   set OTEL_EXPORTER_OTLP_TRACES_ENDPOINT/HEADERS (see `.env.example`).
//   Without either, registration still succeeds and the API serves with
//   no-op observability.
// Failure policy: telemetry must never break startup or serving. Everything
// below is best-effort — any failure keeps the API on no-op observability.
export async function register() {
  try {
    // serviceName MUST match the Vercel project name so trace drains (and
    // the Datadog UI) correlate with this service. DD_SERVICE wins when
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
    // Hobby direct-OTLP defaults: @vercel/otel exports via OTLP env vars
    // when no Vercel drain is configured. Synthesize them from the single
    // DATADOG_API_KEY source so owners never paste the key twice — explicit
    // OTEL_* values (set in Vercel env) always win.
    if (!process.env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL?.trim()) {
      // Datadog's intake only supports http/protobuf.
      process.env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL = "http/protobuf";
    }
    if (!process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS?.trim()) {
      const key =
        process.env.DATADOG_API_KEY?.trim() || process.env.DD_API_KEY?.trim();
      if (key) {
        const site = process.env.DD_SITE?.trim() || "datadoghq.com";
        process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS = `dd-api-key=${key},dd-otlp-source=${site},compute_stats=true`;
      }
    }
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
