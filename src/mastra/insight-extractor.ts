import { z } from "zod";
import type { InsightExtractor } from "../application/insight-extractor.js";
import { insightExtractorAgent } from "./agents/insight-extractor-agent.js";

const insightBase = z.object({
  kind: z.enum([
    "task_category",
    "routine_pattern",
    "energy_stress_marker",
    "automation_candidate",
  ]),
  label: z.string().min(1),
  confidence: z.enum(["low", "medium", "high"]),
});

const extractionSchema = z.object({
  insights: z.array(
    z.discriminatedUnion("kind", [
      insightBase.extend({
        kind: z.literal("task_category"),
        category: z.enum([
          "planning",
          "reporting",
          "meetings",
          "coordination",
          "communication",
          "admin",
          "focus_work",
          "unknown",
        ]),
      }),
      insightBase.extend({
        kind: z.literal("routine_pattern"),
        patternType: z.enum([
          "meeting_overload",
          "context_switching",
          "manual_reporting",
          "coordination_overhead",
          "waiting_for_input",
          "unclear_priority",
          "other",
        ]),
        interferesWith: z.string().min(1).optional(),
      }),
      insightBase.extend({
        kind: z.literal("energy_stress_marker"),
        marker: z.enum([
          "overload",
          "fatigue",
          "frustration",
          "focus_loss",
          "blocked_progress",
          "neutral",
        ]),
        intensity: z.enum(["low", "medium", "high"]),
      }),
      insightBase.extend({
        kind: z.literal("automation_candidate"),
        candidateType: z.enum([
          "report_generation",
          "meeting_reduction",
          "async_status_update",
          "task_routing",
          "template_or_checklist",
          "data_entry_reduction",
          "other",
        ]),
        rationale: z.string().min(1),
      }),
    ]),
  ),
});

export const extractInsightsWithAgent: InsightExtractor = async (input) => {
  if (!input.decision.insightDecision.candidate) return { insights: [] };
  const result = await insightExtractorAgent.generate(buildExtractionPrompt(input));
  const parsed = parseFirstJsonValue(result.text ?? "");
  const validation = extractionSchema.safeParse(parsed);
  if (!validation.success) {
    throw new Error(`insight extraction validation failed: ${validation.error.message}`);
  }
  return {
    insights: validation.data.insights.map((insight) => ({
      ...insight,
      employeeId: input.employeeId,
      threadId: input.threadId,
      sourceMessageId: input.messageId,
    })),
  };
};

function buildExtractionPrompt(input: Parameters<InsightExtractor>[0]) {
  const recentTurns = input.recentTurns
    .slice(-5)
    .map(
      (turn, index) =>
        `${index + 1}. employee: ${compact(turn.userText)}\n   agent: ${compact(turn.agentResponse)}`,
    )
    .join("\n");

  return [
    "# SO-CoT insight extraction task",
    "Return strict JSON only. Do not reveal chain-of-thought.",
    "Use selected business processes and the extraction decision as constraints.",
    "",
    "# Conversation decision",
    JSON.stringify(input.decision, null, 2),
    "",
    "# Current employee text",
    input.text,
    "",
    "# Agent response",
    input.response,
    "",
    "# Recent turns",
    recentTurns || "none",
  ].join("\n");
}

function parseFirstJsonValue(output: string): unknown {
  const trimmed = output.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1];
    if (fenced) return parseFirstJsonValue(fenced);
    const objectStart = trimmed.indexOf("{");
    const objectEnd = trimmed.lastIndexOf("}");
    if (objectStart >= 0 && objectEnd > objectStart) {
      try {
        return JSON.parse(trimmed.slice(objectStart, objectEnd + 1));
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

function compact(text: string) {
  return text.replace(/\s+/g, " ").trim().slice(0, 700);
}
