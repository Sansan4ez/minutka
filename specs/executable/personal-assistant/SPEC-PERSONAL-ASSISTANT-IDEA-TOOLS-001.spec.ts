import { describe, expect, it } from "vitest";
import { IdeaAppendService } from "../../../src/application/idea-append.js";
import { IdeaDeletionService } from "../../../src/application/idea-deletion.js";
import { createInMemoryIdeaDeletionConfirmationStore } from "../../../src/application/in-memory-idea-deletion-confirmation-store.js";
import { createInMemoryIdeaStore } from "../../../src/application/in-memory-idea-store.js";
import type { IdeaMutationResult } from "../../../src/application/idea-store.js";
import { createInMemoryTaskStore } from "../../../src/application/in-memory-task-store.js";
import { createIdeaTools } from "../../../src/mastra/tools/idea-tools.js";

function setup() {
  let now = "2026-07-31T09:00:00.000Z";
  const clock = { now: () => now };
  const ideas = createInMemoryIdeaStore(clock);
  const tasks = createInMemoryTaskStore(clock);
  const service = new IdeaDeletionService(
    ideas,
    createInMemoryIdeaDeletionConfirmationStore(ideas),
    clock,
    { confirmationId: () => "idea-delete-1", tasks },
  );
  const appends = new IdeaAppendService(ideas);
  const tools = createIdeaTools({
    search: (input) => service.search("owner", input),
    append: (input) => appends.append("owner", input),
    propose: (input) => service.propose("owner", input),
    undo: (input) => service.undo("owner", input),
  });
  return { ideas, tasks, service, tools, setNow(value: string) { now = value; } };
}

async function execute<TInput, TOutput>(tool: {
  execute?: (input: TInput, context: never) => TOutput | Promise<TOutput>;
}, input: TInput): Promise<TOutput> {
  if (!tool.execute) throw new Error("expected executable tool");
  return tool.execute(input, {} as never);
}

function parseOutput<T>(tool: { outputSchema?: unknown }, output: unknown): T {
  const outputSchema = tool.outputSchema;
  if (!outputSchema || typeof outputSchema !== "object" || !("parse" in outputSchema) || typeof outputSchema.parse !== "function") {
    throw new Error("expected Zod output schema");
  }
  return outputSchema.parse(output) as T;
}

describe("SPEC-PERSONAL-ASSISTANT-IDEA-TOOLS-001: model-visible idea capabilities", () => {
  it("projects search results to the strict model-visible idea schema", async () => {
    const { ideas, tools } = setup();
    await ideas.add({
      id: "idea-1",
      userId: "owner",
      project: "ASSISTANT",
      type: "knowledge",
      summary: "Review launch notes",
      source: { kind: "text", text: "private raw source" },
      status: "raw",
    });

    const output = await execute(tools.searchIdeas, { query: "launch" });
    const parsed = parseOutput<{ ideas: Array<Record<string, unknown>> }>(tools.searchIdeas, output);

    expect(parsed).toEqual({
      ideas: [{
        id: "idea-1",
        project: "ASSISTANT",
        type: "knowledge",
        summary: "Review launch notes",
        status: "raw",
        createdAt: "2026-07-31T09:00:00.000Z",
        lastActivityAt: "2026-07-31T09:00:00.000Z",
        revision: 1,
      }],
    });
    expect(JSON.stringify(parsed)).not.toMatch(/userId|source|suggestedNextStep|private raw source/);
  });

  it("hides archived ideas by default and returns conversion linkage for explicit archived search", async () => {
    const { ideas, tasks, tools } = setup();
    await ideas.add({ id: "idea-active", userId: "owner", project: "ASSISTANT", type: "knowledge", summary: "Active idea", status: "discussed" });
    await ideas.add({ id: "idea-planned", userId: "owner", project: "ASSISTANT", type: "development", summary: "Converted idea", status: "planned" });
    await tasks.create("owner", { id: "task-from-idea", title: "Converted idea", project: "ASSISTANT", type: "development", status: "open", originIdeaId: "idea-planned" });
    await tasks.create("other", { id: "private-other-task", title: "Private", project: "OTHER", type: "personal", status: "open", originIdeaId: "idea-active" });

    const active = parseOutput<{ ideas: Array<Record<string, unknown>> }>(tools.searchIdeas, await execute(tools.searchIdeas, {}));
    expect(active.ideas).toEqual([expect.objectContaining({ id: "idea-active", status: "discussed" })]);
    expect(JSON.stringify(active)).not.toMatch(/idea-planned|private-other-task/);

    const archived = parseOutput<{ ideas: Array<Record<string, unknown>> }>(tools.searchIdeas, await execute(tools.searchIdeas, { statuses: ["planned"] }));
    expect(archived.ideas).toEqual([expect.objectContaining({ id: "idea-planned", status: "planned", convertedTaskId: "task-from-idea" })]);
  });

  it("appends details to an exact owner idea without exposing owner or source fields", async () => {
    const { ideas, tools, setNow } = setup();
    await ideas.add({
      id: "idea-pool",
      userId: "owner",
      project: "Бассейн",
      type: "personal",
      summary: "Записаться в бассейн",
      source: { kind: "text", text: "private source" },
      status: "raw",
    });
    setNow("2026-07-31T09:30:00.000Z");

    const output = await execute(tools.appendIdea, {
      ideaId: "idea-pool",
      expectedRevision: 1,
      text: "Записался; после бассейна сон был спокойный",
    });
    const parsed = parseOutput<{ status: string; idea: Record<string, unknown> }>(tools.appendIdea, output);

    expect(parsed).toEqual({
      status: "applied",
      idea: expect.objectContaining({
        id: "idea-pool",
        summary: "Записаться в бассейн\n\nЗаписался; после бассейна сон был спокойный",
        lastActivityAt: "2026-07-31T09:30:00.000Z",
        revision: 2,
      }),
    });
    expect(JSON.stringify(parsed)).not.toMatch(/userId|source|private source/);
    await expect(ideas.list("owner")).resolves.toHaveLength(1);
  });

  it("does not append with a stale revision or across owners", async () => {
    const { ideas, tools } = setup();
    await ideas.add({ id: "idea-1", userId: "owner", project: "ASSISTANT", type: "knowledge", summary: "Original", status: "raw" });
    await ideas.update("owner", "idea-1", { status: "discussed" });

    await expect(execute(tools.appendIdea, { ideaId: "idea-1", expectedRevision: 1, text: "Stale" })).resolves.toMatchObject({
      status: "conflict",
      current: { id: "idea-1", summary: "Original", revision: 2 },
    });
    await expect(execute(tools.appendIdea, { ideaId: "missing", expectedRevision: 1, text: "Private" })).resolves.toEqual({ status: "not_found" });
    await expect(ideas.get("owner", "idea-1")).resolves.toMatchObject({ summary: "Original", revision: 2 });
  });

  it.each([
    ["not_found", { status: "not_found" }],
    ["conflict", { status: "conflict" }],
  ] as const)("validates proposeIdeaDeletion %s output", async (_status, serviceOutput) => {
    const tools = createIdeaTools({
      search: async () => [],
      append: async () => ({ status: "not_found" }),
      propose: async () => serviceOutput,
      undo: async () => ({ outcome: "not_found" }),
    });

    const output = await execute(tools.proposeIdeaDeletion, { ideaId: "idea-1", expectedRevision: 1 });

    expect(parseOutput(tools.proposeIdeaDeletion, output)).toEqual(serviceOutput);
  });

  it("validates proposeIdeaDeletion needs_confirmation output without leaking the idea", async () => {
    const { ideas, tools } = setup();
    const idea = await ideas.add({
      id: "idea-1",
      userId: "owner",
      project: "ASSISTANT",
      type: "knowledge",
      summary: "Review launch notes",
      status: "raw",
    });

    const output = await execute(tools.proposeIdeaDeletion, { ideaId: idea.id, expectedRevision: idea.revision });
    const parsed = parseOutput(tools.proposeIdeaDeletion, output);

    expect(parsed).toEqual({
      status: "needs_confirmation",
      confirmation: {
        confirmationId: "idea-delete-1",
        actionKind: "delete_idea",
        summary: "Удалить идею idea-1",
        expiresAt: "2026-07-31T09:15:00.000Z",
      },
    });
    expect(JSON.stringify(parsed)).not.toMatch(/userId|source|Review launch notes/);
  });

  it.each([
    ["restored", { outcome: "restored", idea: { id: "idea-1" } }],
    ["unchanged", { outcome: "unchanged", idea: { id: "idea-1" } }],
    ["deleted", { outcome: "deleted", idea: { id: "idea-1" } }],
    ["already_deleted", { outcome: "already_deleted", idea: { id: "idea-1" } }],
    ["not_found", { outcome: "not_found" }],
    ["expired", { outcome: "expired" }],
    ["conflict", { outcome: "conflict", current: { id: "idea-1" } }],
    ["conflict without current", { outcome: "conflict" }],
  ] as const)("validates undoIdeaDeletion %s output", async (_outcome, serviceOutput) => {
    const tools = createIdeaTools({
      search: async () => [],
      append: async () => ({ status: "not_found" }),
      propose: async () => ({ status: "not_found" }),
      undo: async () => serviceOutput as IdeaMutationResult,
    });

    const output = await execute(tools.undoIdeaDeletion, {});
    const parsed = parseOutput(tools.undoIdeaDeletion, output);

    const expectedOutcome = serviceOutput.outcome === "deleted" || serviceOutput.outcome === "already_deleted"
      ? "unchanged"
      : serviceOutput.outcome;
    expect(parsed).toEqual({
      outcome: expectedOutcome,
      ...("idea" in serviceOutput
        ? { ideaId: serviceOutput.idea.id }
        : "current" in serviceOutput && serviceOutput.current
          ? { ideaId: serviceOutput.current.id }
          : {}),
    });
  });
});
