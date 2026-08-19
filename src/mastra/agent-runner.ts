import type { AssistantAgentContext, AssistantAgentRunner } from "../application/assistant-service.js";
import type { Agent } from "@mastra/core/agent";
import { createMarkProcessUsedTool, markProcessUsedToolName } from "./tools/process-diagnostic-tool.js";
import { normalizeMastraUsage, type MastraTokenUsage, type MastraUsageResult, type ModelUsageWarningLogger } from "./model-usage.js";
import { assistantScheduleToolNames, createScheduleTools } from "./tools/schedule-tools.js";
import { collectActivityToolName, createCollectActivityTool } from "./tools/activity-collection-tool.js";
import { createReadWeeklyActivitiesTool, readWeeklyActivitiesToolName } from "./tools/weekly-activity-tool.js";
import { createReadCycleActivitiesTool, readCycleActivitiesToolName } from "./tools/cycle-activity-tool.js";
import { createUpdatePersonalContextTool, updatePersonalContextToolName } from "./tools/profile-context-tool.js";
import { llmModel } from "../config/llm.js";

/**
 * Toolsets offered to the «Минутка» agent. Tools owned by a process disabled in
 * `vault/assistant/processes/disabled-registry.json` are absent by design: the
 * agent must answer a daily touch with `collectActivity`, and a tool whose
 * manual is outside the prompt would only compete with it.
 */
export const assistantRuntimeToolsets = {
  schedules: assistantScheduleToolNames,
  activities: [collectActivityToolName, readWeeklyActivitiesToolName, readCycleActivitiesToolName],
  profile: [updatePersonalContextToolName],
  diagnostics: [markProcessUsedToolName],
} as const;

export const assistantActiveToolNames = [
  ...assistantRuntimeToolsets.schedules,
  ...assistantRuntimeToolsets.activities,
  ...assistantRuntimeToolsets.profile,
  ...assistantRuntimeToolsets.diagnostics,
] as const;

type MastraToolCall = { payload?: { toolCallId?: string; toolName?: string; args?: unknown } };
type MastraToolResult = { payload?: { toolCallId?: string; toolName?: string; result?: unknown; isError?: boolean } };
type MastraModelStep = {
  text?: string;
  finishReason?: string;
  toolCalls?: MastraToolCall[];
  toolResults?: MastraToolResult[];
  usage?: MastraTokenUsage;
  response?: { modelId?: string; [key: string]: unknown };
  request?: unknown;
  content?: unknown;
  reasoning?: unknown;
  reasoningText?: unknown;
  [key: string]: unknown;
};

type MastraGenerateResult = Omit<MastraUsageResult, "steps"> & {
  text?: string;
  toolCalls?: MastraToolCall[];
  toolResults?: MastraToolResult[];
  steps?: MastraModelStep[];
  finishReason?: string;
  response?: { modelId?: string };
};

type AssistantAgentRunnerOptions = { operationalLogger?: ModelUsageWarningLogger };

export type MastraAgentLike = { generate(text: string, options: any): Promise<MastraGenerateResult> };
type AssistantMastraAgent = Pick<Agent, "generate">;

export function createAssistantToolsets(context: AssistantAgentContext) {
  return {
    schedules: createScheduleTools(context.schedules),
    activities: {
      collectActivity: createCollectActivityTool(context.collectActivity),
      readWeeklyActivities: createReadWeeklyActivitiesTool(context.readWeeklyActivities),
      readCycleActivities: createReadCycleActivitiesTool(context.readCycleActivities),
    },
    profile: { updatePersonalContext: createUpdatePersonalContextTool(context.updatePersonalContext) },
    diagnostics: { markProcessUsed: createMarkProcessUsedTool(context.markProcessUsed) },
  };
}

/** Runtime bridge for the personal assistant; only request-scoped typed tools are enabled. */
export function createAssistantAgentRunner(agent: MastraAgentLike | AssistantMastraAgent, options: AssistantAgentRunnerOptions = {}): AssistantAgentRunner {
  return async (input, context, signal) => {
    const result: MastraGenerateResult = await agent.generate(input.text, {
      system: context.systemContext,
      toolChoice: "auto",
      toolsets: createAssistantToolsets(context),
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
      trace: {
        model: result.response?.modelId ?? [...(result.steps ?? [])].reverse().find((step) => step.response?.modelId)?.response?.modelId ?? llmModel,
        // Preserve Mastra's complete per-step objects. The research-store
        // boundary applies secret filtering before any step reaches storage.
        modelSteps: result.steps ?? [],
        toolCalls: result.toolCalls ?? [],
        toolResults: result.toolResults ?? [],
      },
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
