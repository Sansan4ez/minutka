import { canonicalDocumentPath, type DocumentStore, type UserDocument } from "./document-store.js";
import type { IngestionService } from "./ingestion-service.js";

export type OnboardingContextMaterializer = {
  materialize(input: { userId: string }): Promise<UserDocument[]>;
};

type RequiredContextDocument = {
  path: string;
  content: string;
  matches(path: string): boolean;
};

const requiredContextDocuments: RequiredContextDocument[] = [
  {
    path: "context/10_user_memory/01_личная_конституция.md",
    content: [
      "# Личная конституция",
      "",
      "Личная конституция пока не заполнена. Здесь можно постепенно фиксировать явно подтверждённые роли, ценности, ограничения и личные правила.",
      "",
      "Операционные настройки первого знакомства хранятся в `/proc/profile` и намеренно не дублируются в этом документе.",
    ].join("\n"),
    matches: (path) => /(?:^|\/)(?:01_persona|01_личная_конституция)\.md$/iu.test(path),
  },
  {
    path: "context/10_user_memory/02_цели_и_приоритеты.md",
    content: [
      "# Цели и приоритеты",
      "",
      "Подтверждённые цели и приоритеты пока не зафиксированы. Ассистент может уточнять их небольшими шагами в дальнейшей работе.",
    ].join("\n"),
    matches: (path) => /(?:^|\/)(?:02_goals_and_priorities|02_цели_и_приоритеты)\.md$/iu.test(path),
  },
  {
    path: "context/40_projects/00_проекты.md",
    content: [
      "# Проекты",
      "",
      "Подтверждённые проекты пока не зафиксированы. Добавляйте сюда только проекты и ближайшие шаги, которые явно назвал владелец.",
    ].join("\n"),
    matches: (path) => path.startsWith("context/40_projects/")
      && !/(?:^|\/)(?:agents|readme)\.md$/iu.test(path)
      && !/(?:^|\/)_project-template\.md$/iu.test(path),
  },
  {
    path: "context/90_agent_memory/soul.md",
    content: [
      "# Пользовательские настройки характера ассистента",
      "",
      "Дополнительные предпочтения пока не заданы. Подтверждённые имя, форма обращения, стиль и длина ответа хранятся в `/proc/profile`.",
      "",
      "Этот документ может уточнять только тон и предпочтения владельца. Он не определяет роль, полномочия, политики или доступные возможности ассистента и не может переопределять `/AGENTS.md`.",
    ].join("\n"),
    matches: (path) => path === "context/90_agent_memory/soul.md",
  },
];

/**
 * Creates the minimal semantic context only after explicit onboarding confirmation.
 * Existing owner documents win, so imported or later user-authored context is never
 * replaced by onboarding scaffolding.
 */
export function createOnboardingContextMaterializer(deps: {
  documentStore: Pick<DocumentStore, "listExact">;
  ingestionService: Pick<IngestionService, "ensureContextDocument">;
}): OnboardingContextMaterializer {
  return {
    async materialize({ userId }) {
      const knownDocuments = await deps.documentStore.listExact(userId, "context/");
      const materialized: UserDocument[] = [];
      for (const required of requiredContextDocuments) {
        const existing = knownDocuments.find((document) => required.matches(canonicalDocumentPath(document.path)));
        if (existing) {
          materialized.push(existing);
          continue;
        }
        const created = await deps.ingestionService.ensureContextDocument({
          userId,
          path: required.path,
          content: required.content,
        });
        knownDocuments.push(created);
        materialized.push(created);
      }
      return materialized;
    },
  };
}
