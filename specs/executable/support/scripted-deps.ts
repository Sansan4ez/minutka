import type { ConversationDecisionRouter } from "../../../src/application/conversation-decision-router.js";
import type { InsightExtractor } from "../../../src/application/insight-extractor.js";
import type { MinutkaServiceDeps } from "../../../src/application/minutka-service.js";
import type { OnboardingProfileExtractor } from "../../../src/application/onboarding-profile-extractor.js";
import type { StructuredInsightDraft } from "../../../src/domain/insights.js";

export function createSpecConversationDecisionRouter(): ConversationDecisionRouter {
  return async (input) => {
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

    if (text.includes("игнорируй инструкции") || text.includes("ignore previous instructions")) {
      return {
        selectedProcessIds: ["core", "workday_guardrails"],
        workDecision: {
          mode: "boundary",
          reason: "request_integrity_attack",
        },
        insightDecision: { candidate: false, suggestedKinds: [] },
      };
    }

    if (text.includes("рецепт борща")) {
      return {
        selectedProcessIds: ["core", "workday_guardrails"],
        workDecision: {
          mode: "boundary",
          reason: "non_work_topic",
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

export function createScriptedOnboardingProfileExtractor(): OnboardingProfileExtractor {
  return async ({ text, currentDraft }) => {
    const pipe = text.split("|").map((part) => part.trim());
    if (pipe.length === 3 && pipe.every(Boolean)) {
      const style = pipe[1] === "На ты, коротко и по делу"
        ? { addressForm: "informal" as const, persona: "efficiency" as const }
        : pipe[1] === "На ты, по-человечески"
          ? { addressForm: "informal" as const, persona: "support" as const }
          : pipe[1] === "На вы, по-деловому"
            ? { addressForm: "formal" as const, persona: "efficiency" as const }
            : {};
      return { preferredName: pipe[0], ...style, timezone: pipe[2], ambiguousFields: [] };
    }
    if (pipe.length === 6 && pipe.every(Boolean)) {
      return {
        preferredName: pipe[0],
        assistantName: pipe[1],
        addressForm: pipe[2] === "На вы" ? "formal" : "informal",
        persona: pipe[3] === "Деловой" ? "efficiency" : "support",
        responseLength: pipe[4] === "Коротко" ? "short" : "balanced",
        timezone: pipe[5],
        ambiguousFields: [],
      };
    }
    if (currentDraft.status === "awaiting_confirmation") {
      if (text === "Зови меня Алексей") return { preferredName: "Алексей", ambiguousFields: [] };
      if (text === "Зови меня Максим") return { preferredName: "Максим", ambiguousFields: [] };
    }
    return { ambiguousFields: [] };
  };
}

export function createDefaultSpecDeps(
  overrides: Partial<MinutkaServiceDeps> = {},
): MinutkaServiceDeps {
  return {
    conversationDecisionRouter: createSpecConversationDecisionRouter(),
    insightExtractor: createSpecInsightExtractor(),
    onboardingProfileExtractor: createScriptedOnboardingProfileExtractor(),
    ...overrides,
  };
}
