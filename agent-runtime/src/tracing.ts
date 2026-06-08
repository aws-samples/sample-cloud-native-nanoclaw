/**
 * ClawBot Cloud — invocation tracing helper.
 *
 * Wraps a single agent invocation in an OTEL span carrying ClawBot-specific
 * attributes and an AgentCore-style `session.id` (botId#groupJid) propagated
 * via baggage so downstream spans (AWS SDK, HTTP) inherit it.
 *
 * Uses only `@opentelemetry/api`, which resolves to a no-op implementation when
 * no SDK is registered (local dev / ECS mode / observability disabled) — so
 * this is safe to call unconditionally.
 */

import {
  trace,
  context,
  propagation,
  SpanStatusCode,
} from '@opentelemetry/api';
import type { InvocationPayload } from '@clawbot/shared';

const tracer = trace.getTracer('clawbot-agent-runtime');

/** AgentCore session identifier — one logical session per bot+group. */
export function sessionIdFor(payload: InvocationPayload): string {
  return `${payload.botId}#${payload.groupJid}`;
}

/**
 * Run `fn` inside an `agent.invocation` span with session.id baggage attached.
 * Records exceptions and sets ERROR status on throw, then re-throws.
 */
export async function withInvocationSpan<T>(
  payload: InvocationPayload,
  fn: () => Promise<T>,
): Promise<T> {
  const sessionId = sessionIdFor(payload);

  return tracer.startActiveSpan('agent.invocation', async (span) => {
    span.setAttributes({
      'session.id': sessionId,
      'clawbot.bot_id': payload.botId,
      'clawbot.group_jid': payload.groupJid,
      'clawbot.channel_type': payload.channelType,
      'clawbot.is_scheduled_task': payload.isScheduledTask ?? false,
      'gen_ai.request.model': payload.model ?? 'default',
    });

    const ctx = propagation.setBaggage(
      context.active(),
      propagation.createBaggage({ 'session.id': { value: sessionId } }),
    );

    try {
      return await context.with(ctx, fn);
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      throw err;
    } finally {
      span.end();
    }
  });
}
