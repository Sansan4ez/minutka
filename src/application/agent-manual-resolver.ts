import type { ConversationTurn } from "./conversation-memory-store.js";
import type { UserProfile } from "../domain/employee.js";
import type { WorkPolicyDecision } from "../domain/work-policy.js";
import type {
  AgentManual,
  AgentManualProcessId,
  AgentManualPurpose,
  AgentManualSelection,
} from "./agent-manual-types.js";

export type ResolveAgentManualInput = {
  purpose: AgentManualPurpose;
  text?: string;
  profile?: UserProfile;
  policy?: WorkPolicyDecision;
  recentTurns?: ConversationTurn[];
};

export function resolveAgentManualSelection(
  input: ResolveAgentManualInput,
  manual?: AgentManual,
): AgentManualSelection {
  if (!manual) return { selectedProcessIds: [], manualContext: "" };

  const selected: AgentManualProcessId[] = ["core"];

  if (input.purpose === "onboarding_first_response") {
    selected.push("onboarding", "consent_and_privacy");
  }

  if (input.purpose === "feedback") {
    selected.push("feedback");
  }

  if (input.policy?.allowedForAgent === false) {
    selected.push("workday_guardrails");
    if (hasPrivacyConcern(input.text) || input.policy.reason === "unknown") {
      selected.push("consent_and_privacy");
    }
  }

  if (input.purpose === "chat" && input.policy?.shouldExtractInsights === true) {
    selected.push("insight_extraction");
  }

  if (shouldSelectEveningReflection(input)) {
    selected.push("evening_reflection");
    if (input.policy?.shouldExtractInsights === true) {
      selected.push("insight_extraction");
    }
  }

  if (hasPrivacyConcern(input.text)) {
    selected.push("consent_and_privacy");
  }

  const selectedProcessIds = dedupe(selected).filter((id) => hasManualEntry(manual, id));
  return {
    selectedProcessIds,
    manualContext: renderManualContext(manual, selectedProcessIds),
  };
}

function shouldSelectEveningReflection(input: ResolveAgentManualInput) {
  if (input.purpose !== "chat") return false;
  if (
    input.policy?.reason === "workday_reflection" ||
    input.policy?.reason === "work_emotional_state"
  ) {
    return true;
  }

  const text = normalize(input.text ?? "");
  const hasMorningPlan = (input.recentTurns ?? []).some((turn) =>
    includesAny(normalize(`${turn.userText}\n${turn.agentResponse}`), [
      "утром",
      "сегодня приоритет",
      "приоритет",
      "план",
      "главным был",
    ]),
  );
  return hasMorningPlan && includesAny(text, eveningFallbackPatterns);
}

function hasPrivacyConcern(text?: string) {
  const normalized = normalize(text ?? "");
  return includesAny(normalized, [
    "приват",
    "конфиденц",
    "персональн",
    "личные данные",
    "личные диалоги",
    "компания увидит",
    "компания видит",
    "руководитель увидит",
    "методолог увидит",
    "что видит компания",
    "данные",
    "удалить данные",
  ]);
}

function renderManualContext(
  manual: AgentManual,
  selectedProcessIds: AgentManualProcessId[],
) {
  const sections: string[] = [];
  if (selectedProcessIds.includes("core")) {
    sections.push(["## Agent Manual: core", manual.core.content.trim()].join("\n\n"));
  }

  for (const processId of selectedProcessIds) {
    if (processId === "core") continue;
    const process = manual.processes.find((candidate) => candidate.id === processId);
    if (process) {
      sections.push(
        [`## Agent Manual process: ${process.id}`, process.content.trim()].join("\n\n"),
      );
    }
  }

  return sections.join("\n\n---\n\n");
}

function hasManualEntry(manual: AgentManual, id: AgentManualProcessId) {
  if (id === "core") return Boolean(manual.core.content);
  return manual.processes.some((process) => process.id === id);
}

function dedupe<T>(items: T[]) {
  return [...new Set(items)];
}

function normalize(text: string) {
  return text.toLocaleLowerCase("ru-RU").replace(/ё/g, "е").trim();
}

function includesAny(text: string, patterns: string[]) {
  return patterns.some((pattern) => text.includes(pattern));
}

const eveningFallbackPatterns = [
  "не успел",
  "не успела",
  "весь день",
  "вечер",
  "итог",
  "сегодня",
  "устал",
  "устала",
  "звонк",
  "созвон",
  "встреч",
  "заблокирован",
  "мешало",
];
