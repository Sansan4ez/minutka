import { describe, expect, it } from "vitest";
import { createInMemoryBlobStore } from "../../../src/application/in-memory-blob-store.js";
import { createInMemoryDocumentStore } from "../../../src/application/in-memory-document-store.js";
import { createInMemoryIdeaStore } from "../../../src/application/in-memory-idea-store.js";
import { createInMemoryTaskStore } from "../../../src/application/in-memory-task-store.js";
import { createIngestionService } from "../../../src/application/ingestion-service.js";
import { ProjectLabelService, assistantProjectSourceScanLimit } from "../../../src/application/project-labels.js";
import { createProjectTools } from "../../../src/mastra/tools/project-tools.js";

const clock = { now: () => "2026-08-06T12:00:00.000Z" };

function setup() {
  const ideas = createInMemoryIdeaStore(clock);
  const tasks = createInMemoryTaskStore(clock);
  const projects = new ProjectLabelService(ideas, tasks);
  const ingestion = createIngestionService({
    documentStore: createInMemoryDocumentStore(clock),
    blobStore: createInMemoryBlobStore(clock),
    ideaStore: ideas,
    canonicalizeProject: (userId, project) => projects.canonicalize(userId, project),
  });
  return { ideas, tasks, projects, ingestion };
}

describe("SPEC-PERSONAL-ASSISTANT-PROJECTS-001: project labels", () => {
  it("exposes listProjects as a read-only bounded tool", () => {
    const tool = createProjectTools({ list: async () => ({ projects: [], truncated: false }) }).listProjects;
    expect(tool.mcp?.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect(tool.id).toBe("listProjects");
  });

  it("keeps listProjects owner-scoped and merges idea/task labels without case duplicates", async () => {
    const { ideas, tasks, projects } = setup();
    await ideas.add({ id: "idea-pool", userId: "owner", project: "Бассейн", type: "personal", summary: "Идея", status: "raw" });
    await tasks.create("owner", { id: "task-pool", title: "Задача", project: "бассейн", type: "personal", status: "open" });
    await ideas.add({ id: "idea-secret", userId: "other", project: "Секрет", type: "knowledge", summary: "Чужое", status: "raw" });

    await expect(projects.list("owner")).resolves.toEqual({
      projects: [{ project: "Бассейн", ideaCount: 1, taskCount: 1, totalCount: 2 }],
      truncated: false,
    });
  });

  it("normalizes capture labels and reuses the existing canonical spelling", async () => {
    const { ideas, projects, ingestion } = setup();
    await ideas.add({ id: "existing", userId: "owner", project: "Бассейн", type: "personal", summary: "Существующая", status: "raw" });

    const captured = await ingestion.captureIdea({
      id: "captured",
      userId: "owner",
      project: "  бассейн  ",
      type: "personal",
      summary: "Новая идея",
      suggestedNextStep: "Проверить",
      needsProjectClarification: false,
    });
    expect(captured.idea.project).toBe("Бассейн");

    await ingestion.captureIdea({
      id: "new-label",
      userId: "owner",
      project: "  Новый   проект  ",
      type: "knowledge",
      summary: "Ещё идея",
      suggestedNextStep: "Продолжить",
      needsProjectClarification: false,
    });
    await expect(projects.list("owner")).resolves.toMatchObject({
      projects: expect.arrayContaining([{ project: "Новый проект", ideaCount: 1, taskCount: 0, totalCount: 1 }]),
    });
  });

  it("caps both source scans and output without failing when records exceed the ceiling", async () => {
    const { ideas, tasks, projects } = setup();
    for (let index = 0; index <= assistantProjectSourceScanLimit; index += 1) {
      await ideas.add({ id: `idea-${index}`, userId: "owner", project: `Idea project ${index}`, type: "knowledge", summary: `Idea ${index}`, status: "raw" });
      await tasks.create("owner", { id: `task-${index}`, title: `Task ${index}`, project: `Task project ${index}`, type: "operations", status: "open" });
    }

    const result = await projects.list("owner", { limit: 3 });
    expect(result.projects).toHaveLength(3);
    expect(result.truncated).toBe(true);
  });
});
