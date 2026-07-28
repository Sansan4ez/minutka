import { describe, expect, it } from "vitest";
import { AssistantService } from "../../../src/application/assistant-service.js";
import { createInMemoryBlobStore } from "../../../src/application/in-memory-blob-store.js";
import { createInMemoryConversationStore } from "../../../src/application/in-memory-conversation-store.js";
import { createInMemoryDocumentStore } from "../../../src/application/in-memory-document-store.js";
import { createInMemoryIdeaStore } from "../../../src/application/in-memory-idea-store.js";
import { createInMemoryTaskStore } from "../../../src/application/in-memory-task-store.js";
import { createInMemoryWorld } from "../../../src/application/in-memory-world.js";
import { createIngestionService } from "../../../src/application/ingestion-service.js";
import type { Task } from "../../../src/domain/task.js";

const now = "2026-07-28T09:00:00.000Z";

type FocusResponse = {
  priorities: string[];
  nextAction: string;
  caveats: string[];
};

type Fixture = {
  goals?: string;
  projects?: string;
  ideas?: Array<{ id: string; project: string; summary: string }>;
  tasks?: Array<Pick<Task, "id" | "project" | "title" | "status"> & Partial<Pick<Task, "dueDate">>>;
};

async function runFocus(fixture: Fixture): Promise<{ response: FocusResponse; systemContext: string }> {
  const clock = { now: () => now };
  const world = createInMemoryWorld(clock.now);
  const documents = createInMemoryDocumentStore(clock);
  const ideas = createInMemoryIdeaStore(clock);
  const tasks = createInMemoryTaskStore(clock);
  const ingestion = createIngestionService({ documentStore: documents, blobStore: createInMemoryBlobStore(clock), ideaStore: ideas });

  if (fixture.goals !== undefined) {
    await ingestion.saveContextDocument({
      userId: "owner",
      path: "context/10_user_memory/02_Goals_and_priorities.md",
      content: fixture.goals,
    });
  }
  if (fixture.projects !== undefined) {
    await ingestion.saveContextDocument({
      userId: "owner",
      path: "context/40_projects/2026_07_28_мои_проекты.md",
      content: fixture.projects,
    });
  }
  for (const idea of fixture.ideas ?? []) {
    await ideas.add({ ...idea, userId: "owner", type: "development", status: "raw" });
  }
  for (const task of fixture.tasks ?? []) {
    await tasks.create("owner", { ...task, type: "operations" });
  }

  let systemContext = "";
  const service = new AssistantService(async (_input, context) => {
    systemContext = context.systemContext;
    const goalText = context.personalContext.data.documents
      .filter(({ path }) => path.includes("Goals_and_priorities"))
      .map(({ content }) => content)
      .join("\n");
    const knownProjects = new Set(
      context.personalContext.data.documents
        .filter(({ path }) => path.includes("мои_проекты"))
        .flatMap(({ content }) => content.split(/\r?\n/).map((line) => line.replace(/^[-*#\s]+/, "").trim()).filter(Boolean)),
    );
    const activeTasks = await context.tasks.list({ filter: { status: ["open", "in_progress"] }, order: "due_asc" });
    const overdue = activeTasks.filter(({ dueDate }) => dueDate !== undefined && dueDate < now.slice(0, 10));
    const aligned = activeTasks.filter(({ title, project }) => goalText.includes(title) || goalText.includes(project));
    const ranked = [...overdue, ...aligned, ...activeTasks]
      .filter((task, index, all) => all.findIndex(({ id }) => id === task.id) === index)
      .slice(0, 3);
    const unknown = [...activeTasks.map(({ project }) => project), ...context.records.data.records.map(({ project }) => project)]
      .filter((project) => project === "БЕЗ_ПРОЕКТА" || (knownProjects.size > 0 && !knownProjects.has(project)))
      .filter((project, index, all) => all.indexOf(project) === index);
    const goalConflict = overdue.find((task) => !aligned.some(({ id }) => id === task.id)) !== undefined && aligned.length > 0;
    const priorities = ranked.length > 0
      ? ranked.map(({ title }) => title)
      : context.records.data.records.slice(0, 3).map(({ summary }) => summary);
    return JSON.stringify({
      priorities,
      nextAction: priorities.length === 0 ? "Назвать одну цель или текущую задачу." : `Открыть «${priorities[0]}» и выполнить первый видимый шаг.`,
      caveats: [
        ...(priorities.length === 0 ? ["Недостаточно данных о целях, идеях и задачах."] : []),
        ...unknown.map((project) => `Неизвестный проект: ${project}.`),
        ...(goalConflict ? ["Просроченная задача конфликтует с явно указанной целью владельца."] : []),
      ],
    } satisfies FocusResponse);
  }, {
    documentStore: documents,
    conversationStore: createInMemoryConversationStore(world),
    ingestionService: ingestion,
    ideaStore: ideas,
    taskStore: tasks,
    requestIntegrityGuard: async () => ({ status: "allowed" }),
    clock,
  });

  const result = await service.chat({ userId: "owner", threadId: "thread", text: "На чём мне сфокусироваться сегодня?" });
  return { response: JSON.parse(result.response) as FocusResponse, systemContext };
}

describe("SPEC-PERSONAL-ASSISTANT-DAY-FOCUS-001: internal-first day focus", () => {
  it("returns an honest empty-state answer with one concrete next action", async () => {
    const { response, systemContext } = await runFocus({});

    expect(response.priorities).toEqual([]);
    expect(response.nextAction).toBe("Назвать одну цель или текущую задачу.");
    expect(response.caveats).toContain("Недостаточно данных о целях, идеях и задачах.");
    expect(systemContext).toContain("Process file: day_focus");
    expect(systemContext).toContain("Select at most three priorities");
  });

  it("puts an overdue task into a bounded focus response", async () => {
    const { response } = await runFocus({
      projects: "PLAN",
      tasks: [
        { id: "overdue", project: "PLAN", title: "Подать отчёт", status: "open", dueDate: "2026-07-27" },
        { id: "later-1", project: "PLAN", title: "Подготовить презентацию", status: "open", dueDate: "2026-07-30" },
        { id: "later-2", project: "PLAN", title: "Разобрать заметки", status: "open" },
        { id: "later-3", project: "PLAN", title: "Обновить шаблон", status: "open" },
      ],
    });

    expect(response.priorities[0]).toBe("Подать отчёт");
    expect(response.priorities).toHaveLength(3);
    expect(response.nextAction).toContain("Подать отчёт");
  });

  it("marks an unknown project instead of inventing ownership", async () => {
    const { response } = await runFocus({
      projects: "ASSISTANT",
      ideas: [{ id: "idea-unknown", project: "MYSTERY", summary: "Проверить новую гипотезу" }],
    });

    expect(response.priorities).toEqual(["Проверить новую гипотезу"]);
    expect(response.caveats).toContain("Неизвестный проект: MYSTERY.");
  });

  it("states a conflict between an overdue task and the owner's explicit goal", async () => {
    const { response } = await runFocus({
      goals: "Главная цель: запустить ASSISTANT.\nКлючевой шаг: Подготовить пилот.",
      projects: "ASSISTANT\nLEGACY",
      tasks: [
        { id: "legacy", project: "LEGACY", title: "Закрыть старый отчёт", status: "open", dueDate: "2026-07-27" },
        { id: "goal", project: "ASSISTANT", title: "Подготовить пилот", status: "open", dueDate: "2026-07-31" },
      ],
    });

    expect(response.priorities).toEqual(["Закрыть старый отчёт", "Подготовить пилот"]);
    expect(response.caveats).toContain("Просроченная задача конфликтует с явно указанной целью владельца.");
    expect(response.priorities.length).toBeLessThanOrEqual(3);
    expect(response.nextAction).toBeTruthy();
  });
});
