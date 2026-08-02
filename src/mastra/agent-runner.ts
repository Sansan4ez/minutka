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
  steps?: Array<{ usage?: MastraTokenUsage }>;
};

export type MastraAgentLike = { generate(text: string, options: any): Promise<MastraGenerateResult> };
type AssistantMastraAgent = Pick<Agent, "generate">;

/** Runtime bridge for the personal assistant; only request-scoped typed tools are enabled. */
export function createAssistantAgentRunner(agent: MastraAgentLike | AssistantMastraAgent): AssistantAgentRunner {
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
    const usage = normalizedUsage(result);
    return {
      text: result.text ?? "",
      executionTrace: successfulToolNames(result).map((toolName) => ({ kind: "tool" as const, toolName })),
      ...(usage ? { usage } : {}),
    };
  };
}

function normalizedUsage(result: Pick<MastraGenerateResult, "usage" | "steps">): { inputTokens: number; outputTokens: number; totalTokens: number; llmSteps: number; cachedInputTokens?: number } | undefined {
  const usage = result.usage;
  if (!usage) return undefined;
  const inputTokens = usage.inputTokens ?? usage.promptTokens;
  const outputTokens = usage.outputTokens ?? usage.completionTokens;
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  const steps = result.steps ?? [];
  const cachedInputTokens = usage.cachedInputTokens ?? sumReportedCachedInputTokens(steps);
  return {
    inputTokens,
    outputTokens,
    totalTokens: usage.totalTokens ?? inputTokens + outputTokens,
    llmSteps: Math.max(1, steps.length),
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
  };
}

function sumReportedCachedInputTokens(steps: Array<{ usage?: MastraTokenUsage }>): number | undefined {
  const reported = steps.map((step) => step.usage?.cachedInputTokens).filter((tokens): tokens is number => tokens !== undefined);
  return reported.length === 0 ? undefined : reported.reduce((total, tokens) => total + tokens, 0);
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
