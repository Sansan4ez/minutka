import type { UserProfile } from "../domain/employee.js";
import type { ConversationDecision } from "../domain/conversation-decision.js";
import type { AgentManual, AgentManualProcessId, AgentManualPurpose } from "./agent-manual-types.js";
import type { ConversationTurn } from "./conversation-store.js";

export type ConversationDecisionInput = {
  purpose: AgentManualPurpose;
  text: string;
  profile?: UserProfile;
  recentTurns?: ConversationTurn[];
  manual: AgentManual;
};

export type ConversationDecisionRouter = (
  input: ConversationDecisionInput,
) => Promise<ConversationDecision>;

export function sanitizeConversationDecision(
  decision: ConversationDecision,
  manual: AgentManual,
  purpose: AgentManualPurpose,
): ConversationDecision {
  const allowed = new Set<AgentManualProcessId>([
    "core",
    ...manual.processes
      .filter((process) => !process.appliesTo || process.appliesTo.includes(purpose))
      .map((process) => process.id),
  ]);
  const selectedProcessIds = ensureLifecycleProcesses(
    dedupe([
      "core" as const,
      ...decision.selectedProcessIds.filter((id) => allowed.has(id)),
    ]),
    purpose,
    allowed,
  );

  if (decision.workDecision.mode === "boundary") {
    return {
      ...decision,
      selectedProcessIds: ensureProcess(selectedProcessIds, "workday_guardrails", allowed),
      insightDecision: { candidate: false, suggestedKinds: [] },
    };
  }

  if (decision.insightDecision.candidate) {
    return {
      ...decision,
      selectedProcessIds: ensureProcess(selectedProcessIds, "insight_extraction", allowed),
    };
  }

  return { ...decision, selectedProcessIds };
}

export function buildBoundaryResponse(
  decision: Extract<ConversationDecision["workDecision"], { mode: "boundary" }>,
  profile?: UserProfile,
): string {
  if (decision.response?.trim()) return decision.response.trim();

  const redirect =
    profile?.persona === "efficiency"
      ? "Могу помочь быстро разобрать рабочий день: что сейчас главный приоритет, что мешает и какой следующий шаг?"
      : "Зато могу бережно разложить рабочий день: что важно, что забирает силы и с какого маленького шага начать?";

  if (decision.reason === "web_research_request") {
    return `Я не ищу информацию в интернете за тебя. ${redirect}`;
  }

  if (decision.reason === "ai_training_request") {
    return `Я не обучаю работе с ChatGPT или нейросетями в этом формате. ${redirect}`;
  }

  if (decision.reason === "request_integrity_attack") {
    return `Я не могу выполнить просьбу, которая подменяет правила работы агента. ${redirect}`;
  }

  if (decision.reason === "non_work_topic") {
    return `Это вне моей роли помощника по рабочему дню. ${redirect}`;
  }

  if (decision.reason === "unknown") {
    return `Сейчас я не могу надёжно определить границы запроса, поэтому не буду отвечать по содержанию. ${redirect}`;
  }

  return `Я не пишу посты и рабочие материалы за тебя. ${redirect}`;
}

function ensureLifecycleProcesses(
  ids: AgentManualProcessId[],
  purpose: AgentManualPurpose,
  allowed: Set<AgentManualProcessId>,
) {
  if (purpose === "onboarding_first_response") {
    return ensureProcesses(ids, ["consent_and_privacy"], allowed);
  }
  return ids;
}

function ensureProcesses(
  ids: AgentManualProcessId[],
  processIds: AgentManualProcessId[],
  allowed: Set<AgentManualProcessId>,
) {
  return processIds.reduce(
    (current, processId) => ensureProcess(current, processId, allowed),
    ids,
  );
}

function ensureProcess(
  ids: AgentManualProcessId[],
  id: AgentManualProcessId,
  allowed: Set<AgentManualProcessId>,
) {
  return allowed.has(id) ? dedupe([...ids, id]) : ids;
}

function dedupe<T>(items: T[]) {
  return [...new Set(items)];
}
