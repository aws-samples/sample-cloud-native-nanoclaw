/**
 * ClawBot Cloud — OpenTelemetry bootstrap (AgentCore Observability)
 *
 * Loaded as a side-effect BEFORE the app via `node --import ./dist/otel.js`.
 * Must run before any instrumented module (http, @aws-sdk/*, fastify) is
 * imported so the OTEL ESM loader hook can patch them.
 *
 * Why the AWS ADOT distro instead of a hand-rolled OTLP exporter?
 * AgentCore Runtime *container* deployments are "collector-less": there is NO
 * in-VM OTEL collector and AgentCore does NOT inject an OTLP endpoint. App
 * spans must be sent DIRECTLY to the regional X-Ray OTLP endpoint
 * (https://xray.<region>.amazonaws.com/v1/traces), and that endpoint requires
 * SigV4-signed requests. A plain `@opentelemetry/exporter-trace-otlp-*` cannot
 * sign, so its spans are silently rejected — which is why only AgentCore's own
 * server-side `AgentCore.Runtime.Invoke` span showed up in CloudWatch.
 *
 * `@aws/aws-distro-opentelemetry-node-autoinstrumentation/register` provides
 * the SigV4 exporter, auto-configures the X-Ray endpoint + propagators
 * (baggage,xray,tracecontext) from AWS_REGION, and registers the global
 * TracerProvider — all gated internally on AGENT_OBSERVABILITY_ENABLED=true.
 *
 * The distro's `register` is CommonJS and patches `require()`; this package is
 * ESM. We register `@opentelemetry/instrumentation/hook.mjs` first so its
 * http/aws-sdk instrumentations can also patch ESM imports. Independently, our
 * manual `agent.invocation` spans (see tracing.ts) always export through the
 * provider the distro registers — so tracing works even where ESM patching
 * doesn't.
 *
 * Activation is gated on AGENT_OBSERVABILITY_ENABLED (set on the AgentCore
 * runtime by deploy.sh). Unset in local dev / ECS mode → this is a no-op.
 * DISABLE_ADOT_OBSERVABILITY=true also opts out.
 */

import { register } from 'node:module';

const enabled =
  process.env.AGENT_OBSERVABILITY_ENABLED === 'true' &&
  process.env.DISABLE_ADOT_OBSERVABILITY !== 'true';

if (enabled) {
  try {
    // Patch ESM imports so the distro's instrumentations can hook them (Node >= 20.6).
    register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);

    // Side-effect import: sets AWS OTLP defaults (X-Ray endpoint from AWS_REGION,
    // SigV4 exporter, X-Ray ID generator/sampler/propagators) and starts the SDK.
    await import('@aws/aws-distro-opentelemetry-node-autoinstrumentation/register');

    // eslint-disable-next-line no-console
    console.log(
      `[otel] AgentCore observability enabled — exporting traces to ${
        process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? '(region-default X-Ray endpoint)'
      }`,
    );
  } catch (err) {
    // Never let telemetry setup crash the agent.
    // eslint-disable-next-line no-console
    console.error('[otel] Failed to initialize OpenTelemetry, continuing without tracing:', err);
  }
}
