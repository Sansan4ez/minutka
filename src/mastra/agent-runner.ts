import type { AssistantAgentRunner } from "../application/assistant-service.js";
import type { Agent } from "@mastra/core/agent";
import { createCaptureIdeaTool } from "./tools/capture-idea-tool.js";
import { assistantDocumentToolNames, createDocumentTools } from "./tools/document-tools.js";
import { assistantTaskToolNames, createTaskTools } from "./tools/task-tools.js";
import { createMarkProcessUsedTool, markProcessUsedToolName } from "./tools/process-diagnostic-tool.js";

export const assistantRuntimeToolsets = {
  inbox: ["captureIdea"],
  documents: assistantDocumentToolNames,
  tasks: assistantTaskToolNames,
  diagnostics: [markProcessUsedToolName],
} as const;

export const assistantActiveToolNames = [
  ...assistantRuntimeToolsets.inbox,
  ...assistantRuntimeToolsets.documents,
  ...assistantRuntimeToolsets.tasks,
  ...assistantRuntimeToolsets.diagnostics,
] as const;

type MastraGenerateResult = {
  text?: string;
  toolCalls?: Array<{ payload?: { toolCallId?: string; toolName?: string } }>;
  toolResults?: Array<{ payload?: { toolCallId?: string; toolName?: string; isError?: boolean } }>;
  usage?: { promptTokens?: number; completionTokens?: number; inputTokens?: number; outputTokens?: number; totalTokens?: number };
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
        tasks: createTaskTools(context.tasks),
        diagnostics: { markProcessUsed: createMarkProcessUsedTool(context.markProcessUsed) },
      },
      // `activeTools` is applied after all toolsets are resolved, so ambient
      // agent-level tools cannot be selected during the personal assistant run.
      activeTools: [...assistantActiveToolNames],
      maxSteps: 4,
      ...(signal ? { abortSignal: signal } : {}),
    });
    const usage = normalizedUsage(result.usage);
    return {
      text: result.text ?? "",
      executionTrace: successfulToolNames(result).map((toolName) => ({ kind: "tool" as const, toolName })),
      ...(usage ? { usage } : {}),
    };
  };
}

function normalizedUsage(usage: MastraGenerateResult["usage"]): { inputTokens: number; outputTokens: number; totalTokens: number } | undefined {
  if (!usage) return undefined;
  const inputTokens = usage.inputTokens ?? usage.promptTokens;
  const outputTokens = usage.outputTokens ?? usage.completionTokens;
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  return { inputTokens, outputTokens, totalTokens: usage.totalTokens ?? inputTokens + outputTokens };
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
