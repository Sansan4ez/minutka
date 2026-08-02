import type { ModelTokenUsage } from "../application/usage-store.js";

export type MastraTokenUsage = {
  promptTokens?: number;
  completionTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
};

/** The three places Mastra can report token usage, in the order this runtime trusts them. */
export type MastraUsageSource = "totalUsage" | "steps" | "usage";

export type MastraUsageResult = {
  usage?: MastraTokenUsage;
  totalUsage?: MastraTokenUsage;
  steps?: Array<{ usage?: MastraTokenUsage }>;
};

export type ModelUsageWarning = {
  type: "assistant_agent_usage_cached_input_exceeds_input";
  source: MastraUsageSource;
  inputTokens: number;
  cachedInputTokens: number;
};

export type ModelUsageWarningLogger = (warning: ModelUsageWarning) => void;

/**
 * Aggregates one LLM call into a single consistent area: `inputTokens`,
 * `outputTokens`, `totalTokens` and `cachedInputTokens` always come from the
 * same reporting source, never mixed between a single step and the whole call.
 */
export function normalizeMastraUsage(
  result: MastraUsageResult,
  operationalLogger: ModelUsageWarningLogger = logModelUsageWarning,
): (ModelTokenUsage & { llmSteps: number }) | undefined {
  const steps = result.steps ?? [];
  const selected = selectCallUsage(result, steps);
  if (!selected) return undefined;
  const inputTokens = selected.usage.inputTokens ?? selected.usage.promptTokens;
  const outputTokens = selected.usage.outputTokens ?? selected.usage.completionTokens;
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  const cachedInputTokens = selected.usage.cachedInputTokens;
  // The producer owns the invariant: an inconsistent cache report drops the
  // cached field instead of failing the store boundary and losing the whole row.
  const validCachedInputTokens = cachedInputTokens === undefined || cachedInputTokens <= inputTokens
    ? cachedInputTokens
    : undefined;
  if (cachedInputTokens !== undefined && validCachedInputTokens === undefined) {
    warnOperationally(operationalLogger, {
      type: "assistant_agent_usage_cached_input_exceeds_input",
      source: selected.source,
      inputTokens,
      cachedInputTokens,
    });
  }
  return {
    inputTokens,
    outputTokens,
    totalTokens: selected.usage.totalTokens ?? inputTokens + outputTokens,
    llmSteps: Math.max(1, steps.length),
    ...(validCachedInputTokens === undefined ? {} : { cachedInputTokens: validCachedInputTokens }),
  };
}

function selectCallUsage(
  result: Pick<MastraUsageResult, "usage" | "totalUsage">,
  steps: Array<{ usage?: MastraTokenUsage }>,
): { source: MastraUsageSource; usage: MastraTokenUsage } | undefined {
  if (result.totalUsage) return { source: "totalUsage", usage: result.totalUsage };
  const stepUsage = sumStepUsage(steps);
  if (stepUsage) return { source: "steps", usage: stepUsage };
  return result.usage ? { source: "usage", usage: result.usage } : undefined;
}

function sumStepUsage(steps: Array<{ usage?: MastraTokenUsage }>): MastraTokenUsage | undefined {
  const reported = steps.map((step) => step.usage).filter((usage): usage is MastraTokenUsage => usage !== undefined);
  if (reported.length === 0) return undefined;
  const inputTokens = sumTokenField(reported, (usage) => usage.inputTokens ?? usage.promptTokens);
  const outputTokens = sumTokenField(reported, (usage) => usage.outputTokens ?? usage.completionTokens);
  const totalTokens = sumTokenField(reported, (usage) => usage.totalTokens);
  const cachedInputTokens = sumTokenField(reported, (usage) => usage.cachedInputTokens);
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
  };
}

function sumTokenField(usages: MastraTokenUsage[], select: (usage: MastraTokenUsage) => number | undefined): number | undefined {
  const reported = usages.map(select).filter((tokens): tokens is number => tokens !== undefined);
  return reported.length === 0 ? undefined : reported.reduce((total, tokens) => total + tokens, 0);
}

function warnOperationally(logger: ModelUsageWarningLogger, warning: ModelUsageWarning): void {
  try { logger(warning); }
  catch (error) { console.warn(`Assistant agent usage warning failed (${error instanceof Error ? error.name : "UnknownError"}).`); }
}

function logModelUsageWarning(warning: ModelUsageWarning): void {
  console.warn("Assistant agent usage warning.", warning);
}
