import { describe, expect, it } from "vitest";
import { IdeaDeletionService } from "../../../src/application/idea-deletion.js";
import { createInMemoryIdeaDeletionConfirmationStore } from "../../../src/application/in-memory-idea-deletion-confirmation-store.js";
import { createInMemoryIdeaStore } from "../../../src/application/in-memory-idea-store.js";
import type { IdeaMutationResult } from "../../../src/application/idea-store.js";
import { createIdeaTools } from "../../../src/mastra/tools/idea-tools.js";

function setup() {
  let now = "2026-07-31T09:00:00.000Z";
  const clock = { now: () => now };
  const ideas = createInMemoryIdeaStore(clock);
  const service = new IdeaDeletionService(
    ideas,
    createInMemoryIdeaDeletionConfirmationStore(ideas),
    clock,
    { confirmationId: () => "idea-delete-1" },
  );
  const tools = createIdeaTools({
    search: (input) => service.search("owner", input),
    propose: (input) => service.propose("owner", input),
    undo: (input) => service.undo("owner", input),
  });
  return { ideas, service, tools, setNow(value: string) { now = value; } };
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

  it.each([
    ["not_found", { status: "not_found" }],
    ["conflict", { status: "conflict" }],
  ] as const)("validates proposeIdeaDeletion %s output", async (_status, serviceOutput) => {
    const tools = createIdeaTools({
      search: async () => [],
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
