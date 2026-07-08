import type { UserProfile } from "../domain/employee.js";

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
