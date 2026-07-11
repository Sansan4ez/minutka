import { z } from "zod";
import type { ConversationDecisionRouter } from "../application/conversation-decision-router.js";
import type { ConversationDecision } from "../domain/conversation-decision.js";
import type { InsightKind } from "../domain/insights.js";
import { compact } from "../shared/llm-output.js";
import { conversationDecisionAgent } from "./agents/conversation-decision-agent.js";

const processId = z.enum([
  "core",
  "onboarding",
  "consent_and_privacy",
  "evening_reflection",
  "workday_guardrails",
  "insight_extraction",
  "feedback",
]);
const insightKind = z.enum([
  "task_category",
  "routine_pattern",
  "energy_stress_marker",
  "automation_candidate",
]);

const workDecisionReason = z.enum([
  "workday_reflection",
  "planning_or_prioritization",
  "work_emotional_state",
  "onboarding",
  "feedback",
  "ambiguous",
  "content_generation_request",
  "web_research_request",
  "ai_training_request",
  "non_work_topic",
  "request_integrity_attack",
  "unknown",
]);

export const conversationDecisionSchema = z.object({
  selectedProcessIds: z.array(processId),
  workDecision: z.discriminatedUnion("mode", [
    z.object({
      mode: z.literal("allow"),
      reason: z.enum([
        "workday_reflection",
        "planning_or_prioritization",
        "work_emotional_state",
        "onboarding",
        "feedback",
        "ambiguous",
        "unknown",
      ]),
    }),
    z.object({
      mode: z.literal("boundary"),
      reason: z.enum([
        "content_generation_request",
        "web_research_request",
        "ai_training_request",
        "non_work_topic",
        "request_integrity_attack",
        "unknown",
      ]),
      response: z.string().optional(),
    }),
  ]),
  insightDecision: z.object({
    candidate: z.boolean(),
    suggestedKinds: z.array(insightKind),
  }),
});

// OpenAI Responses strict JSON Schema does not accept the `oneOf` emitted by
// z.discriminatedUnion. Keep the domain schema above, but request a flat
// transport shape and validate it again against the domain schema below.
const decisionTransportSchema = z.object({
  selectedProcessIds: z.array(processId),
  workDecision: z.object({
    mode: z.enum(["allow", "boundary"]),
    reason: workDecisionReason,
    response: z.string().nullable(),
  }),
  insightDecision: z.object({
    candidate: z.boolean(),
    suggestedKinds: z.array(insightKind),
  }),
});

export type ConversationDecisionGeneration = {
  object?: unknown;
};

export type ConversationDecisionGenerator = (
  prompt: string,
) => Promise<ConversationDecisionGeneration>;

export function createConversationDecisionRouter(
  generate: ConversationDecisionGenerator,
): ConversationDecisionRouter {
  return async (input) => {
    const result = await generate(buildDecisionPrompt(input));
    const transportValidation = decisionTransportSchema.safeParse(result.object);
    if (!transportValidation.success) {
      throw new Error(
        `conversation decision structured output validation failed: ${transportValidation.error.message}`,
      );
    }

    const { response, ...workDecision } = transportValidation.data.workDecision;
    const decision = {
      ...transportValidation.data,
      workDecision:
        workDecision.mode === "allow" || response === null
          ? workDecision
          : { ...workDecision, response },
    };
    const validation = conversationDecisionSchema.safeParse(decision);
    if (!validation.success) {
      throw new Error(
        `conversation decision structured output validation failed: ${validation.error.message}`,
      );
    }
    return validation.data;
  };
}

export const routeConversationDecision = createConversationDecisionRouter(
  async (prompt) => {
    const result = await conversationDecisionAgent.generate(prompt, {
      structuredOutput: {
        schema: decisionTransportSchema,
      },
    });
    return { object: result.object };
  },
);

function buildDecisionPrompt(input: Parameters<ConversationDecisionRouter>[0]) {
  const candidateProcessIds = input.manual.processes
    .filter((process) => !process.appliesTo || process.appliesTo.includes(input.purpose))
    .map((process) => process.id);
  const processSummaries = input.manual.processes
    .filter((process) => candidateProcessIds.includes(process.id))
    .map((process) => `- ${process.id}: ${preview(process.content)}`)
    .join("\n");
  const recentTurns = (input.recentTurns ?? [])
    .slice(-5)
    .map(
      (turn, index) =>
        `${index + 1}. employee: ${compact(turn.userText)}\n   agent: ${compact(turn.agentResponse)}`,
    )
    .join("\n");
  const profile = input.profile
    ? [
        `role: ${input.profile.role}`,
        `typicalTasks: ${input.profile.typicalTasks.join(", ")}`,
        `persona: ${input.profile.persona}`,
        `aiLevel: ${input.profile.aiLevel}`,
        `responseLength: ${input.profile.responseLength}`,
      ].join("\n")
    : "not available";

  return [
    "# SO-CoT conversation decision routing task",
    "Return an object that exactly matches the provided output schema.",
    "Do not reveal chain-of-thought; make a concise internal decision only.",
    "",
    "# Process index",
    input.manual.processIndex?.content.trim() ?? "Process index unavailable.",
    "",
    "# Candidate process ids",
    JSON.stringify(["core", ...candidateProcessIds]),
    "",
    "# Candidate process summaries",
    processSummaries || "No optional candidates.",
    "",
    "# Runtime input",
    `purpose: ${input.purpose}`,
    `employeeText: ${input.text}`,
    "",
    "# Profile",
    profile,
    "",
    "# Recent turns",
    recentTurns || "none",
  ].join("\n");
}

function preview(content: string) {
  const start = content.indexOf("## When this process applies");
  const source = start >= 0 ? content.slice(start) : content;
  return compact(source).slice(0, 500);
}

export type RuntimeInsightKind = InsightKind;
export type RuntimeConversationDecision = ConversationDecision;
