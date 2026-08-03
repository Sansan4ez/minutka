import type { AssistantAgentRunner } from "../application/assistant-service.js";
import type { Agent } from "@mastra/core/agent";
import { createCaptureIdeaTool } from "./tools/capture-idea-tool.js";
import { assistantDocumentToolNames, createDocumentTools } from "./tools/document-tools.js";
import { assistantTaskToolNames, createTaskTools } from "./tools/task-tools.js";
import { createMarkProcessUsedTool, markProcessUsedToolName } from "./tools/process-diagnostic-tool.js";
import { normalizeMastraUsage, type MastraUsageResult, type ModelUsageWarningLogger } from "./model-usage.js";
import { assistantIdeaToolNames, createIdeaTools } from "./tools/idea-tools.js";
import { assistantScheduleToolNames, createScheduleTools } from "./tools/schedule-tools.js";
import { assistantContextDocumentMutationToolNames, createContextDocumentMutationTools } from "./tools/context-document-mutation-tools.js";

export const assistantRuntimeToolsets = {
  inbox: ["captureIdea"],
  documents: assistantDocumentToolNames,
  contextDocuments: assistantContextDocumentMutationToolNames,
  ideas: assistantIdeaToolNames,
  tasks: assistantTaskToolNames,
  schedules: assistantScheduleToolNames,
  diagnostics: [markProcessUsedToolName],
} as const;

export const assistantActiveToolNames = [
  ...assistantRuntimeToolsets.inbox,
  ...assistantRuntimeToolsets.documents,
  ...assistantRuntimeToolsets.contextDocuments,
  ...assistantRuntimeToolsets.ideas,
  ...assistantRuntimeToolsets.tasks,
  ...assistantRuntimeToolsets.schedules,
  ...assistantRuntimeToolsets.diagnostics,
] as const;

type MastraGenerateResult = MastraUsageResult & {
  text?: string;
  toolCalls?: Array<{ payload?: { toolCallId?: string; toolName?: string } }>;
  toolResults?: Array<{ payload?: { toolCallId?: string; toolName?: string; isError?: boolean } }>;
};

type AssistantAgentRunnerOptions = { operationalLogger?: ModelUsageWarningLogger };

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
        contextDocuments: createContextDocumentMutationTools(context.contextDocuments),
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
    const usage = normalizeMastraUsage(result, options.operationalLogger);
    return {
      text: result.text ?? "",
      executionTrace: successfulToolNames(result).map((toolName) => ({ kind: "tool" as const, toolName })),
      ...(usage ? { usage } : {}),
    };
  };
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
