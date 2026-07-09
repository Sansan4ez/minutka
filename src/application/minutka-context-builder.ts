import type { UserProfile } from "../domain/employee.js";
import type { ConversationTurn } from "./conversation-memory-store.js";
import type {
  AgentManual,
  AgentManualProcessId,
  AgentManualPurpose,
} from "./agent-manual-types.js";
import {
  renderManualContext,
  resolveAgentManualSelection,
  type AgentManualRouter,
} from "./agent-manual-resolver.js";

const personaLabels = {
  support: "Поддержка",
  efficiency: "Эффективность",
} as const;

const personaRules = {
  support: [
    "отвечай тёпло и бережно, на стороне сотрудника;",
    "сначала признай состояние или нагрузку, затем предложи структуру;",
    "избегай давления, директивности и оценок.",
  ],
  efficiency: [
    "отвечай по делу, структурно, без лишнего сочувствия;",
    "помогай найти следующий практический шаг;",
    "фокусируйся на приоритетах и экономии времени, не дави и не оценивай.",
  ],
} as const;

export type BuildMinutkaContextInput = {
  purpose: AgentManualPurpose;
  text?: string;
  profile?: UserProfile;
  recentTurns?: ConversationTurn[];
  selectedProcessIds?: AgentManualProcessId[];
};

export type BuiltMinutkaContext = {
  systemContext: string;
  selectedProcessIds: AgentManualProcessId[];
};

export type MinutkaContextBuilderLike = {
  build(input: BuildMinutkaContextInput): Promise<BuiltMinutkaContext>;
};

export function buildMinutkaProfileContext(profile: UserProfile): string {
  const aiRule =
    profile.aiLevel === "beginner"
      ? "Если сотрудник не знаком с ИИ, не упоминай ChatGPT/нейросети первым; говори про шаблоны, упрощение и повторяемость."
      : "Можно аккуратно предложить ускорение через ИИ-инструменты, если это уместно; не обучай ИИ-инструментам в обычном ответе.";

  return [
    "Профиль сотрудника:",
    `- Роль: ${profile.role}`,
    `- Типовые задачи: ${profile.typicalTasks.join(", ")}`,
    `- Уровень знакомства с ИИ: ${profile.aiLevel}`,
    `- Предпочтительная длина ответа: ${profile.responseLength}`,
    "",
    `Выбранная персона: ${personaLabels[profile.persona]}.`,
    "Правила тона:",
    ...personaRules[profile.persona].map((rule) => `- ${rule}`),
    "",
    aiRule,
  ].join("\n");
}

export async function buildMinutkaContext(
  input: BuildMinutkaContextInput,
  deps: { manual?: AgentManual; router?: AgentManualRouter } = {},
): Promise<BuiltMinutkaContext> {
  const manualSelection = input.selectedProcessIds && deps.manual
    ? {
        selectedProcessIds: input.selectedProcessIds,
        manualContext: renderManualContext(deps.manual, input.selectedProcessIds),
      }
    : await resolveAgentManualSelection(input, deps.manual, deps.router);
  const sections = ["# Minutka runtime context"];

  if (manualSelection.manualContext) {
    sections.push(manualSelection.manualContext);
  }

  if (input.profile) {
    sections.push(["## Profile context", buildMinutkaProfileContext(input.profile)].join("\n\n"));
  }

  return {
    systemContext: sections.join("\n\n"),
    selectedProcessIds: manualSelection.selectedProcessIds,
  };
}

export function createMinutkaContextBuilder(
  manual?: AgentManual,
  router?: AgentManualRouter,
): MinutkaContextBuilderLike {
  return {
    build: (input) => buildMinutkaContext(input, { manual, router }),
  };
}
