/**
 * ClawBot Cloud — invocation tracing helper (GenAI semantic conventions).
 *
 * The Claude Agent SDK runs the actual LLM calls in a spawned Claude Code
 * subprocess, so the parent process's HTTP / @aws-sdk auto-instrumentation never
 * sees them — the AgentCore "GenAI Observability" dashboard would otherwise show
 * nothing but the server-side `AgentCore.Runtime.Invoke` span. Here we manually
 * reconstruct the GenAI trace from the data the SDK already streams back through
 * `query()` (model, token usage, tool calls, finish reason, turn count):
 *
 *   agent.invocation            ← invoke_agent span (this whole turn-loop)
 *     ├─ chat <model>           ← one CLIENT span per assistant turn (1 inference)
 *     │    └─ (event) gen_ai.tool.message  ← one per tool_use in that turn
 *     └─ chat <model>           ← next turn …
 *
 * Spans/attributes follow the OpenTelemetry GenAI semantic conventions
 * (https://opentelemetry.io/docs/specs/semconv/gen-ai/) so CloudWatch recognises
 * them as model invocations.
 *
 * Uses only `@opentelemetry/api`, which resolves to a no-op implementation when
 * no SDK is registered (local dev / ECS mode / observability disabled) — so this
 * is safe to call unconditionally.
 */

import {
  trace,
  context,
  propagation,
  SpanStatusCode,
  SpanKind,
} from '@opentelemetry/api';
import type { InvocationPayload } from '@clawbot/shared';

const tracer = trace.getTracer('clawbot-agent-runtime');

/** AgentCore session identifier — one logical session per bot+group. */
export function sessionIdFor(payload: InvocationPayload): string {
  return `${payload.botId}#${payload.groupJid}`;
}

/** OTEL GenAI `gen_ai.system` value for this invocation. */
export function genAiSystem(payload: InvocationPayload): string {
  return payload.modelProvider === 'anthropic-api' ? 'anthropic' : 'aws.bedrock';
}

/**
 * Run `fn` inside an `agent.invocation` span (GenAI `invoke_agent` operation)
 * with session.id baggage attached. Records exceptions and sets ERROR status on
 * throw, then re-throws. The per-turn `chat` spans created by {@link createTurnTracer}
 * nest under this span because `fn` runs in its active context.
 */
export async function withInvocationSpan<T>(
  payload: InvocationPayload,
  fn: () => Promise<T>,
): Promise<T> {
  const sessionId = sessionIdFor(payload);

  return tracer.startActiveSpan('agent.invocation', async (span) => {
    span.setAttributes({
      // GenAI semantic conventions — surfaced in CloudWatch GenAI Observability.
      'gen_ai.operation.name': 'invoke_agent',
      'gen_ai.system': genAiSystem(payload),
      'gen_ai.agent.name': payload.botName,
      'gen_ai.request.model': payload.model ?? 'default',
      // ClawBot-specific context.
      'session.id': sessionId,
      'clawbot.bot_id': payload.botId,
      'clawbot.group_jid': payload.groupJid,
      'clawbot.channel_type': payload.channelType,
      'clawbot.is_scheduled_task': payload.isScheduledTask ?? false,
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

/** Max chars for a content attribute. X-Ray caps a whole segment at ~64KB, so
 *  per-turn input/output/tool text is truncated to keep spans well under that. */
const MAX_CONTENT_CHARS = 4000;
function truncate(s: string, max = MAX_CONTENT_CHARS): string {
  return s.length > max ? `${s.slice(0, max)}…[+${s.length - max} chars]` : s;
}

/** Per-assistant-turn data extracted from the SDK message stream. */
export interface AssistantTurn {
  /** Model that produced this response (`message.message.model`). */
  responseModel?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  /** `message.message.stop_reason` for this turn. */
  finishReason?: string | null;
  /** tool_use blocks issued by the model in this turn (name + args). */
  toolUses?: Array<{ name?: string; id?: string; input?: unknown }>;
  /** Assistant text produced this turn (the model output). */
  outputText?: string;
  /** Input that drove this turn: the user prompt (turn 0) or tool results (later). */
  inputText?: string;
}

/** Final-result aggregates extracted from the SDK `result` message. */
export interface ResultAggregate {
  inputTokens?: number;
  outputTokens?: number;
  numTurns?: number;
  costUsd?: number;
  finishReason?: string | null;
}

/**
 * Emits one GenAI `chat` CLIENT span per assistant turn, timed from the start of
 * the inference (set by {@link TurnTracer.begin} / {@link TurnTracer.markInferenceStart})
 * to when the assistant message arrives. Spans parent off the currently-active
 * `agent.invocation` span automatically.
 */
export interface TurnTracer {
  /** Mark the start of the first inference (call right before the message loop). */
  begin(): void;
  /** Mark the start of the next inference — call when a tool-result message arrives. */
  markInferenceStart(): void;
  /** Emit a `chat <model>` span for one completed assistant turn. */
  recordAssistantTurn(turn: AssistantTurn): void;
  /** Set aggregate usage/turn/cost attributes on the active invoke_agent span. */
  finalizeFromResult(result: ResultAggregate): void;
}

export function createTurnTracer(payload: InvocationPayload, systemPrompt?: string): TurnTracer {
  const system = genAiSystem(payload);
  const requestModel = payload.model ?? 'default';
  const sessionId = sessionIdFor(payload);
  let turnStart = Date.now();
  let turnIndex = 0;

  return {
    begin() {
      turnStart = Date.now();
    },
    markInferenceStart() {
      turnStart = Date.now();
    },
    recordAssistantTurn(turn) {
      const model = turn.responseModel || requestModel;
      // Tool calls go in a span ATTRIBUTE, not span events: AgentCore's trace
      // pipeline (X-Ray + Transaction Search aws/spans) drops OTEL span events
      // entirely — only attributes survive — so addEvent() would be a no-op here.
      const toolNames = (turn.toolUses ?? []).map((t) => t.name).filter((n): n is string => !!n);
      // Tool call arguments, joined as "name: {json}" lines (truncated).
      const toolArgs = (turn.toolUses ?? [])
        .filter((t) => t.input != null)
        .map((t) => `${t.name ?? 'tool'}: ${JSON.stringify(t.input)}`)
        .join('\n');
      const span = tracer.startSpan(`chat ${model}`, {
        kind: SpanKind.CLIENT,
        startTime: turnStart,
        attributes: {
          'gen_ai.operation.name': 'chat',
          'gen_ai.system': system,
          'gen_ai.request.model': requestModel,
          'gen_ai.response.model': model,
          'session.id': sessionId,
          ...(turn.inputTokens != null && { 'gen_ai.usage.input_tokens': turn.inputTokens }),
          ...(turn.outputTokens != null && { 'gen_ai.usage.output_tokens': turn.outputTokens }),
          ...(turn.cacheCreationTokens != null && {
            'clawbot.usage.cache_creation_input_tokens': turn.cacheCreationTokens,
          }),
          ...(turn.cacheReadTokens != null && {
            'clawbot.usage.cache_read_input_tokens': turn.cacheReadTokens,
          }),
          ...(turn.finishReason && { 'gen_ai.response.finish_reasons': [turn.finishReason] }),
          ...(toolNames.length > 0 && {
            'gen_ai.tool.names': toolNames.join(','),
            'gen_ai.tool.count': toolNames.length,
          }),
          // Content — visible per-turn in the span's Metadata (truncated). The
          // dedicated GenAI "Events" panel needs the logs pipeline; these carry
          // the same input/output/tool detail as trace attributes instead.
          ...(turn.inputText && { 'gen_ai.input': truncate(turn.inputText) }),
          ...(turn.outputText && { 'gen_ai.output': truncate(turn.outputText) }),
          ...(toolArgs && { 'gen_ai.tool.arguments': truncate(toolArgs) }),
          // System prompt once, on the first turn (it's identical across turns).
          ...(turnIndex === 0 && systemPrompt && { 'gen_ai.system.prompt': truncate(systemPrompt) }),
        },
      });
      span.end();
      turnIndex++;
    },
    finalizeFromResult(result) {
      const span = trace.getActiveSpan();
      if (!span) return;
      span.setAttributes({
        ...(result.inputTokens != null && { 'gen_ai.usage.input_tokens': result.inputTokens }),
        ...(result.outputTokens != null && { 'gen_ai.usage.output_tokens': result.outputTokens }),
        ...(result.numTurns != null && { 'clawbot.agent.num_turns': result.numTurns }),
        ...(result.costUsd != null && { 'clawbot.agent.cost_usd': result.costUsd }),
        ...(result.finishReason && { 'gen_ai.response.finish_reasons': [result.finishReason] }),
      });
    },
  };
}
