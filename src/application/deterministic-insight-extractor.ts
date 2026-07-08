import type { StructuredInsightDraft } from "../domain/insights.js";
import type { InMemoryWorld } from "./in-memory-world.js";
import type { InsightExtractionInput, InsightExtractor } from "./insight-extractor.js";

export type DeterministicInsightDraftInput = Pick<
  InsightExtractionInput,
  "employeeId" | "threadId" | "messageId" | "text"
> &
  Partial<Pick<InsightExtractionInput, "recentTurns">>;

export function createDeterministicInsightExtractor(
  _world?: InMemoryWorld,
): InsightExtractor {
  return async (input) => ({
    insights: extractInsightDraftsDeterministically(input),
  });
}

export function extractInsightDraftsDeterministically(
  input: DeterministicInsightDraftInput,
): StructuredInsightDraft[] {
  const text = normalize(input.text);
  const drafts: StructuredInsightDraft[] = [];
  const base = {
    employeeId: input.employeeId,
    threadId: input.threadId,
    sourceMessageId: input.messageId,
  };

  if (includesAny(text, ["отчет", "квартальный отчет", "report"])) {
    drafts.push({
      ...base,
      kind: "task_category",
      label: "отчёт",
      confidence: "high",
      category: "reporting",
    });
  }

  if (includesAny(text, ["звонк", "созвон", "встреч"])) {
    drafts.push({
      ...base,
      kind: "task_category",
      label: "встречи",
      confidence: "medium",
      category: "meetings",
    });
  }

  if (
    includesAny(text, [
      "весь день на звонках",
      "встречи съели день",
      "созвоны мешали",
      "созвоны сьели день",
      "весь день были встречи",
    ])
  ) {
    drafts.push({
      ...base,
      kind: "routine_pattern",
      label: "звонки/встречи",
      confidence: "high",
      patternType: "meeting_overload",
      interferesWith: includesAny(text, ["отчет", "квартальный отчет"])
        ? "квартальный отчёт"
        : undefined,
    });
  }

  if (
    includesAny(text, [
      "не успел",
      "не успела",
      "не продвинулся",
      "не продвинулась",
      "заблокирован",
      "заблокирована",
    ])
  ) {
    drafts.push({
      ...base,
      kind: "energy_stress_marker",
      label: "прогресс заблокирован",
      confidence: "medium",
      marker: "blocked_progress",
      intensity: "medium",
    });
  }

  if (includesAny(text, ["устал", "устала", "выгорел", "выгорела", "сил нет"])) {
    drafts.push({
      ...base,
      kind: "energy_stress_marker",
      label: "усталость",
      confidence: "medium",
      marker: "fatigue",
      intensity: "medium",
    });
  }

  if (
    includesAny(text, ["каждый день отчет", "ручной отчет", "ручной отчёт"])
  ) {
    drafts.push({
      ...base,
      kind: "automation_candidate",
      label: "автоматизация отчёта",
      confidence: "medium",
      candidateType: "report_generation",
      rationale: "повторяющийся ручной отчёт",
    });
  }

  if (includesAny(text, ["копирую данные", "вбиваю данные", "ручной ввод"])) {
    drafts.push({
      ...base,
      kind: "automation_candidate",
      label: "сокращение ручного ввода",
      confidence: "medium",
      candidateType: "data_entry_reduction",
      rationale: "повторяющийся ручной перенос данных",
    });
  }

  const previousMeetingOverloadCount = (input.recentTurns ?? []).filter((turn) => {
    const previous = normalize(`${turn.userText} ${turn.agentResponse}`);
    return includesAny(previous, ["весь день на звонках", "встречи съели день", "созвоны мешали"]);
  }).length;

  if (
    previousMeetingOverloadCount >= 1 &&
    includesAny(text, ["звонк", "созвон", "встреч"])
  ) {
    drafts.push({
      ...base,
      kind: "automation_candidate",
      label: "сокращение встреч",
      confidence: "low",
      candidateType: "meeting_reduction",
      rationale: "повторяющаяся перегрузка встречами",
    });
  }

  return deduplicateDrafts(drafts);
}

function deduplicateDrafts(drafts: StructuredInsightDraft[]) {
  const seen = new Set<string>();
  return drafts.filter((draft) => {
    const key = `${draft.kind}:${draft.label}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalize(text: string) {
  return text.toLocaleLowerCase("ru-RU").replace(/ё/g, "е");
}

function includesAny(text: string, patterns: string[]) {
  return patterns.some((pattern) => text.includes(pattern));
}
