import type { AssistantAgentRunner } from "../application/assistant-service.js";
import type { Agent } from "@mastra/core/agent";
import { createCaptureIdeaTool } from "./tools/capture-idea-tool.js";
import { assistantDocumentToolNames, createDocumentTools } from "./tools/document-tools.js";
import { assistantTaskToolNames, createTaskTools } from "./tools/task-tools.js";
import { createMarkProcessUsedTool, markProcessUsedToolName } from "./tools/process-diagnostic-tool.js";
import { assistantIdeaToolNames, createIdeaTools } from "./tools/idea-tools.js";
import { assistantScheduleToolNames, createScheduleTools } from "./tools/schedule-tools.js";

export const assistantRuntimeToolsets = {
  inbox: ["captureIdea"],
  documents: assistantDocumentToolNames,
  ideas: assistantIdeaToolNames,
  tasks: assistantTaskToolNames,
  schedules: assistantScheduleToolNames,
  diagnostics: [markProcessUsedToolName],
} as const;

export const assistantActiveToolNames = [
  ...assistantRuntimeToolsets.inbox,
  ...assistantRuntimeToolsets.documents,
  ...assistantRuntimeToolsets.ideas,
  ...assistantRuntimeToolsets.tasks,
  ...assistantRuntimeToolsets.schedules,
  ...assistantRuntimeToolsets.diagnostics,
] as const;

type MastraTokenUsage = {
  promptTokens?: number;
  completionTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
};

type MastraGenerateResult = {
  text?: string;
  toolCalls?: Array<{ payload?: { toolCallId?: string; toolName?: string } }>;
  toolResults?: Array<{ payload?: { toolCallId?: string; toolName?: string; isError?: boolean } }>;
  usage?: MastraTokenUsage;
  totalUsage?: MastraTokenUsage;
  steps?: Array<{ usage?: MastraTokenUsage }>;
};

type UsageSource = "totalUsage" | "steps" | "usage";
type AssistantAgentUsageWarning = {
  type: "assistant_agent_usage_cached_input_exceeds_input";
  source: UsageSource;
  inputTokens: number;
  cachedInputTokens: number;
};
type AssistantAgentRunnerOptions = { operationalLogger?: (warning: AssistantAgentUsageWarning) => void };

export type MastraAgentLike = { generate(text: string, options: any): Promise<MastraGenerateResult> };
type AssistantMastraAgent = Pick<Agent, "generate">;

/** Runtime bridge for the personal assistant; only request-scoped typed tools are enabled. */
export function createAssistantAgentRunner(agent: MastraAgentLike | AssistantMastraAgent, options: AssistantAgentRunnerOptions = {}): AssistantAgentRunner {
  return async (input, context, signal) => {
    const result: MastraGenerateResult = await agent.generate(input.text, {
      system: context.systemContext,
      toolChoice: "auto",
      toolsets: {
        inbox: { captureIdea: createCaptureIdeaTool(context.captureIdea) },
        documents: createDocumentTools(context.documents),
        ideas: createIdeaTools(context.ideas),
        tasks: createTaskTools(context.tasks),
        schedules: createScheduleTools(context.schedules),
        diagnostics: { markProcessUsed: createMarkProcessUsedTool(context.markProcessUsed) },
      },
      // `activeTools` is applied after all toolsets are resolved, so ambient
      // agent-level tools cannot be selected during the personal assistant run.
      activeTools: [...assistantActiveToolNames],
      maxSteps: 4,
      ...(signal ? { abortSignal: signal } : {}),
    });
    const usage = normalizedUsage(result, options.operationalLogger ?? logAssistantAgentUsageWarning);
    return {
      text: result.text ?? "",
      executionTrace: successfulToolNames(result).map((toolName) => ({ kind: "tool" as const, toolName })),
      ...(usage ? { usage } : {}),
    };
  };
}

function normalizedUsage(
  result: Pick<MastraGenerateResult, "usage" | "totalUsage" | "steps">,
  operationalLogger: (warning: AssistantAgentUsageWarning) => void,
): { inputTokens: number; outputTokens: number; totalTokens: number; llmSteps: number; cachedInputTokens?: number } | undefined {
  const steps = result.steps ?? [];
  const selected = selectTurnUsage(result, steps);
  if (!selected) return undefined;
  const inputTokens = selected.usage.inputTokens ?? selected.usage.promptTokens;
  const outputTokens = selected.usage.outputTokens ?? selected.usage.completionTokens;
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  const cachedInputTokens = selected.usage.cachedInputTokens;
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

function selectTurnUsage(
  result: Pick<MastraGenerateResult, "usage" | "totalUsage">,
  steps: Array<{ usage?: MastraTokenUsage }>,
): { source: UsageSource; usage: MastraTokenUsage } | undefined {
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

function warnOperationally(logger: (warning: AssistantAgentUsageWarning) => void, warning: AssistantAgentUsageWarning): void {
  try { logger(warning); }
  catch (error) { console.warn(`Assistant agent usage warning failed (${error instanceof Error ? error.name : "UnknownError"}).`); }
}

function logAssistantAgentUsageWarning(warning: AssistantAgentUsageWarning): void {
  console.warn("Assistant agent usage warning.", warning);
}

function successfulToolNames(result: Awaited<ReturnType<MastraAgentLike["generate"]>>): string[] {
  const successfulCallIds = new Set(
    (result.toolResults ?? [])
      .filter(({ payload }) => payload?.isError !== true && payload?.toolCallId)
      .map(({ payload }) => payload!.toolCallId!),
  );
  return (result.toolCalls ?? [])
    .filter(({ payload }) => payload?.toolName && (!payload.toolCallId || successfulCallIds.has(payload.toolCallId)))
    .map(({ payload }) => payload!.toolName!);
}
