import {
  createContextBudgetConfig,
  sourceCharacterCeiling,
  type ContextBudgetConfig,
  type ContextSourceId,
} from "./context-budget.js";

export type ProviderContextOverflowReason =
  | "context_length_exceeded"
  | "prompt_too_long"
  | "token_limit_exceeded";

export const overflowRecoveryUserMessage =
  "Не удалось сформировать ответ из-за ограничения контекста модели. Сообщение сохранено; сократите или разделите запрос и попробуйте ещё раз.";

const overflowAfterDurableWriteUserMessage =
  "Не удалось сформировать ответ из-за ограничения контекста модели. Идея уже сохранена; повторно отправлять запрос не нужно.";

export class AssistantContextOverflowError extends Error {
  readonly code = "context_overflow" as const;
  readonly durableEffectCommitted: boolean;

  constructor(readonly reason: ProviderContextOverflowReason, options: { cause?: unknown; durableEffectCommitted?: boolean } = {}) {
    const durableEffectCommitted = options.durableEffectCommitted ?? false;
    super(durableEffectCommitted ? overflowAfterDurableWriteUserMessage : overflowRecoveryUserMessage, options);
    this.name = "AssistantContextOverflowError";
    this.durableEffectCommitted = durableEffectCommitted;
  }
}

/**
 * Deterministic one-shot recovery preset. Guaranteed core sources retain their
 * configured ceilings; only lower-value records/history and the machine index
 * are reduced. Construction goes through the canonical config validator.
 */
export function createOverflowRecoveryContextBudget(base: ContextBudgetConfig): ContextBudgetConfig {
  const ceiling = (id: ContextSourceId) => sourceCharacterCeiling(base, id);
  const records = Math.min(ceiling("records"), 3_000);
  const history = Math.min(ceiling("history"), 3_000);
  const contextIndex = Math.min(ceiling("context_index"), 3_000);
  const sources = Object.fromEntries(base.sources.map((source) => [
    source.id,
    source.id === "records" ? records
      : source.id === "history" ? history
        : source.id === "context_index" ? contextIndex
          : source.ceiling,
  ])) as Record<ContextSourceId, number>;

  return createContextBudgetConfig({
    total: base.total,
    responseReserve: base.responseReserve,
    sources,
    projectionLimits: {
      ...base.projectionLimits,
      contextIndexDepth: Math.min(base.projectionLimits.contextIndexDepth, 2),
      records: Math.min(base.projectionLimits.records, 8),
      recordCharacters: Math.min(base.projectionLimits.recordCharacters, records),
      historyTurns: Math.min(base.projectionLimits.historyTurns, 4),
      historyTurnCharacters: Math.min(base.projectionLimits.historyTurnCharacters, history),
    },
    documentTools: { ...base.documentTools },
  });
}

/** Classifies only provider context-window failures; throttling wins explicitly. */
export function classifyProviderContextOverflow(error: unknown): ProviderContextOverflowReason | undefined {
  const signals = collectErrorSignals(error);
  const joined = signals.join("\n").toLowerCase();
  if (signals.some((signal) => signal === "429") || rateLimitPattern.test(joined)) return undefined;
  if (contextLengthPattern.test(joined)) return "context_length_exceeded";
  if (promptTooLongPattern.test(joined)) return "prompt_too_long";
  if (tokenLimitPattern.test(joined)) return "token_limit_exceeded";
  return undefined;
}

const rateLimitPattern = /(?:rate[_ -]?limit|too many requests|throttl|resource[_ -]?exhausted|quota exceeded)/iu;
const contextLengthPattern = /(?:context[_ -]?length[_ -]?exceeded|maximum context length|context window[^\n]*(?:exceed|limit|too (?:large|long))|input length[^\n]*context limit|reduce the length of (?:the )?messages)/iu;
const promptTooLongPattern = /(?:prompt is too long|prompt[_ -]?too[_ -]?long|input is too long|request too large for (?:this|the) model)/iu;
const tokenLimitPattern = /(?:too many tokens|token(?:s| count)?[^\n]*(?:exceed|above)[^\n]*(?:maximum|limit)|max_tokens[^\n]*(?:exceed|context limit))/iu;

function collectErrorSignals(root: unknown): string[] {
  const signals: string[] = [];
  const queue: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  const visited = new Set<object>();
  while (queue.length > 0 && signals.length < 40) {
    const current = queue.shift()!;
    if (typeof current.value === "string" || typeof current.value === "number") {
      signals.push(String(current.value));
      continue;
    }
    if (!current.value || typeof current.value !== "object" || current.depth > 4 || visited.has(current.value)) continue;
    visited.add(current.value);
    const record = current.value as Record<string, unknown>;
    for (const key of ["name", "message", "code", "type", "status", "statusCode"] as const) {
      const value = record[key];
      if (typeof value === "string" || typeof value === "number") signals.push(String(value));
    }
    for (const key of ["cause", "error", "data", "response", "body", "lastError"] as const) {
      if (record[key] !== undefined) queue.push({ value: record[key], depth: current.depth + 1 });
    }
  }
  return signals;
}
