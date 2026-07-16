import type { UserProfile } from "../domain/employee.js";
import type { ConversationTurn } from "./conversation-store.js";
import type { ProcSnapshot } from "./runtime-projections/runtime-projection-types.js";
import { renderRuntimeProjection } from "./runtime-projections/runtime-projection-renderer.js";
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
  /** Scoped application snapshot; replaces the legacy duplicated profile context. */
  runtimeProjection?: ProcSnapshot;
  decisionProjection?: import("./runtime-projections/runtime-projection-types.js").RuntimeProjection<import("./runtime-projections/runtime-projection-types.js").DecisionProjection>;
  selectedProcessIds?: AgentManualProcessId[];
};

export type BuiltMinutkaContext = {
  systemContext: string;
  selectedProcessIds: AgentManualProcessId[];
};

export type MinutkaContextBuilderLike = {
  build(input: BuildMinutkaContextInput): Promise<BuiltMinutkaContext>;
};

function buildMinutkaPersonaContext(profile: UserProfile): string {
  const aiRule = profile.aiLevel === "beginner"
    ? "Не упоминай ChatGPT/нейросети первым; говори про шаблоны, упрощение и повторяемость."
    : "Не превращай обычный ответ в обучение ИИ-инструментам без запроса.";

  return [
    `Выбранная персона: ${personaLabels[profile.persona]}.`,
    "Правила тона:",
    ...personaRules[profile.persona].map((rule) => `- ${rule}`),
    "",
    aiRule,
  ].join("\n");
}

/** Legacy standalone profile renderer; runtime chat uses the projection snapshot instead. */
export function buildMinutkaProfileContext(profile: UserProfile): string {
  return [
    "Профиль владельца:",
    `- Обращение: ${profile.preferredName ?? profile.role ?? profile.employeeId}`,
    `- Имя ассистента: ${profile.assistantName ?? "Ассистент"}`,
    `- Форма обращения: ${profile.addressForm ?? "informal"}`,
    `- Часовой пояс: ${profile.timezone ?? "Etc/UTC"}`,
    ...(profile.role ? [`- Legacy role context: ${profile.role}`] : []),
    ...(profile.typicalTasks?.length ? [`- Legacy task context: ${profile.typicalTasks.join(", ")}`] : []),
    `- Предпочтительная длина ответа: ${profile.responseLength}`,
    "",
    buildMinutkaPersonaContext(profile),
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

  if (input.runtimeProjection) {
    if (input.profile) {
      sections.push(["## Persona context", buildMinutkaPersonaContext(input.profile)].join("\n\n"));
    }
    sections.push(renderRuntimeProjection(input.runtimeProjection, input.decisionProjection));
  } else if (input.profile) {
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
