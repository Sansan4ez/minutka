import type { ConversationDecisionRouter } from "../../../src/application/conversation-decision-router.js";
import type { InsightExtractor } from "../../../src/application/insight-extractor.js";
import type { MinutkaServiceDeps } from "../../../src/application/minutka-service.js";
import type { StructuredInsightDraft } from "../../../src/domain/insights.js";

export function createSpecConversationDecisionRouter(): ConversationDecisionRouter {
  return async (input) => {
    if (input.purpose === "feedback") {
      return {
        selectedProcessIds: ["core", "feedback"],
        workDecision: { mode: "allow", reason: "feedback" },
        insightDecision: { candidate: false, suggestedKinds: [] },
      };
    }

    const text = input.text.toLocaleLowerCase("ru-RU").replace(/ё/g, "е");

    if (text.includes("напиши") && text.includes("пост")) {
      return {
        selectedProcessIds: ["core", "workday_guardrails"],
        workDecision: {
          mode: "boundary",
          reason: "content_generation_request",
        },
        insightDecision: { candidate: false, suggestedKinds: [] },
      };
    }

    if (text.includes("научи") && (text.includes("chatgpt") || text.includes("нейросет"))) {
      return {
        selectedProcessIds: ["core", "workday_guardrails"],
        workDecision: {
          mode: "boundary",
          reason: "ai_training_request",
        },
        insightDecision: { candidate: false, suggestedKinds: [] },
      };
    }

    const isWorkSignal =
      text.includes("приоритет") ||
      text.includes("отчет") ||
      text.includes("звон") ||
      text.includes("встреч") ||
      text.includes("не успел") ||
      text.includes("рабочий день");
    const isEvening = text.includes("не успел") || text.includes("весь день");

    return {
      selectedProcessIds: [
        "core",
        ...(isEvening ? (["evening_reflection"] as const) : []),
        ...(isWorkSignal ? (["insight_extraction"] as const) : []),
      ],
      workDecision: {
        mode: "allow",
        reason: text.includes("приоритет")
          ? "planning_or_prioritization"
          : isWorkSignal
            ? "workday_reflection"
            : "ambiguous",
      },
      insightDecision: {
        candidate: isWorkSignal,
        suggestedKinds: isWorkSignal
          ? ["task_category", "routine_pattern", "energy_stress_marker"]
          : [],
      },
    };
  };
}

export function createSpecInsightExtractor(): InsightExtractor {
  return async (input) => {
    const text = input.text.toLocaleLowerCase("ru-RU").replace(/ё/g, "е");
    const base = {
      employeeId: input.employeeId,
      threadId: input.threadId,
      sourceMessageId: input.messageId,
    };
    const insights: StructuredInsightDraft[] = [];

    if (text.includes("отчет") || text.includes("report")) {
      insights.push({
        ...base,
        kind: "task_category",
        label: "отчёт",
        confidence: "high",
        category: "reporting",
      });
    }

    if (text.includes("звон") || text.includes("встреч")) {
      insights.push({
        ...base,
        kind: "task_category",
        label: "встречи",
        confidence: "medium",
        category: "meetings",
      });
    }

    if (text.includes("весь день") || text.includes("созвоны мешали")) {
      insights.push({
        ...base,
        kind: "routine_pattern",
        label: "звонки/встречи",
        confidence: "high",
        patternType: "meeting_overload",
        interferesWith: text.includes("отчет") ? "квартальный отчёт" : undefined,
      });
    }

    if (text.includes("не успел") || text.includes("заблокирован")) {
      insights.push({
        ...base,
        kind: "energy_stress_marker",
        label: "прогресс заблокирован",
        confidence: "medium",
        marker: "blocked_progress",
        intensity: "medium",
      });
    }

    return { insights };
  };
}

export function createDefaultSpecDeps(
  overrides: Partial<MinutkaServiceDeps> = {},
): MinutkaServiceDeps {
  return {
    conversationDecisionRouter: createSpecConversationDecisionRouter(),
    insightExtractor: createSpecInsightExtractor(),
    ...overrides,
  };
}
