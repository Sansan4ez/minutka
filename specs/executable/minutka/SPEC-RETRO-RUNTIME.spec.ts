import { describe, expect, it } from "vitest";
import { createInMemoryRuntime } from "../../../src/runtime/create-in-memory-runtime.js";
import { createInMemoryWorld } from "../../../src/application/in-memory-world.js";
import { InMemoryWorkRetrospectivePolicyStore } from "../../../src/application/work-retrospective-policy.js";
import { createInMemoryConversationStore } from "../../../src/application/in-memory-conversation-store.js";
import { createInMemoryWorkRetrospectiveStore } from "../../../src/application/in-memory-work-retrospective-store.js";
import { createWorkRetrospectiveService } from "../../../src/application/work-retrospective-service.js";
import { retrospectiveUpdateSchema } from "../../../src/application/work-retrospective-request.js";
import type { AssistantAgentRunner } from "../../../src/application/assistant-service.js";

const now = "2026-08-26T12:00:00.000Z";
const question = "Как вы проверили готовый отчёт?";
function fixture(runner: AssistantAgentRunner, world = createInMemoryWorld(() => now)) {
  if (!world.participants.length) for (const groupId of ["g1", "g2"]) {
    world.participants.push({ employeeId: groupId, companyId: "c", groupId, subjectKey: `subject_${groupId}`, roleId: "role", status: "profile_completed", createdAt: now, updatedAt: now });
    world.profiles.push({ employeeId: groupId, companyId: "c", groupId, roleId: "role", preferredName: "Анна", assistantName: "Минутка", addressForm: "formal", persona: "support", responseLength: "short", timezone: "Etc/UTC", createdAt: now, updatedAt: now });
  }
  return createInMemoryRuntime({ world, agentRunner: async () => "unused", assistantAgentRunner: runner,
    workRetrospectivePolicies: new InMemoryWorkRetrospectivePolicyStore([{ companyId: "c", groupId: "g1", enabled: true, period: { start: "2026-08-26T00:00:00.000Z", end: "2026-09-09T00:00:00.000Z" }, methodVersion: "v1" }]) });
}
const chat = (runtime: ReturnType<typeof fixture>, userId = "g1", text = "Подготовил отчёт") => runtime.assistantChat!.chat({ userId, threadId: "thread", text });
const asking: AssistantAgentRunner = async (_, context) => {
  if (context.workRetrospective) await context.workRetrospective.update({ question: { text: question, stage: "actions" } });
  return { text: context.workRetrospective ? question : "Принято", executionTrace: [] };
};
describe("request-bound retrospective runtime", () => {
  it("SPEC-RETRO-RUNTIME-01 enabled group gets handoff and disabled group retains old capabilities", async () => {
    const runtime = fixture(asking);
    expect((await chat(runtime)).response).toBe(question);
    expect((await chat(runtime, "g2")).response).toBe("Принято");
    expect(runtime.world.messages[0]?.metadata?.retrospectiveEvents).toHaveLength(2);
  });
  it("SPEC-RETRO-RUNTIME-02 foreign identity or target is rejected without writes", async () => {
    expect(retrospectiveUpdateSchema.safeParse({ employeeId: "other", target: "other", question: { text: question, stage: "actions" } }).success).toBe(false);
    const runtime = fixture(async (_, context) => {
      expect(await context.workRetrospective!.update({ target: "other" } as never)).toMatchObject({ status: "failed" });
      return { text: "Принято", executionTrace: [] };
    });
    await chat(runtime);
    expect(runtime.world.messages[0]?.metadata?.retrospectiveEvents).toBeUndefined();
  });
  it("SPEC-RETRO-RUNTIME-03 episode failure does not undo factual write or promise continuation", async () => {
    let facts = 0;
    const runtime = fixture(async (_, context) => {
      await context.processCurrentActivityTurn({ mode: "record" });
      await context.workRetrospective!.update({ question: { text: question, stage: "actions" } });
      return { text: question, executionTrace: [] };
    });
    const canonical = createInMemoryConversationStore(runtime.world);
    const store = createInMemoryWorkRetrospectiveStore(canonical);
    const failing = createWorkRetrospectiveService({ ...store, appendTurnWithEvents: async () => ({ status: "failed", code: "persistence_error" }) }, canonical);
    // Inject a store failure through the application composition, not model input.
    const { AssistantService } = await import("../../../src/application/assistant-service.js");
    const { createInMemoryProfileStore } = await import("../../../src/application/in-memory-profile-store.js");
    const assistant = new AssistantService(async (_, context) => {
      await context.processCurrentActivityTurn({ mode: "record" });
      await context.workRetrospective!.update({ question: { text: question, stage: "actions" } });
      return { text: question, executionTrace: [] };
    }, { documentStore: runtime.documentStore, conversationStore: canonical, ingestionService: { saveContextDocument: async () => { throw new Error("unused"); }, captureIdea: async () => { throw new Error("unused"); } }, participantStore: createInMemoryProfileStore(runtime.world), requestIntegrityGuard: async () => ({ status: "allowed" }), clock: { now: () => now }, processCurrentActivityTurn: async () => { facts++; return { status: "completed", operation: "collect", savedCount: 1, activityIds: ["a"], extraction: { context: { currentTextCharacters: 0, staticRulesCharacters: 0, durationReferencesCharacters: 0, recentCandidatesCharacters: 0, promptCharacters: 0 } } }; }, workRetrospective: { service: failing, policies: new InMemoryWorkRetrospectivePolicyStore([{ companyId: "c", groupId: "g1", enabled: true, period: { start: "2026-08-26T00:00:00.000Z", end: "2026-09-09T00:00:00.000Z" }, methodVersion: "v1" }]) } });
    expect((await assistant.chat({ userId: "g1", threadId: "thread", text: "Отчёт" })).response).toContain("не запланированы");
    expect(facts).toBe(1);
  });
  it("SPEC-RETRO-RUNTIME-04 restart binds yes to the exact durable question independently of history", async () => {
    const runtime = fixture(asking);
    await chat(runtime);
    const restarted = fixture(async (_, context) => {
      const bound = JSON.parse(await context.workRetrospective!.read());
      expect(bound.active.question.text).toBe(question);
      expect(bound.active.question.target.episodeId).toBe(bound.active.episodeId);
      await context.workRetrospective!.update({ closeReason: "answered" });
      return { text: "Принято", executionTrace: [] };
    }, runtime.world);
    await chat(restarted, "g1", "да");
    expect(runtime.world.messages.at(-1)?.metadata?.retrospectiveEvents?.[0]?.action.type).toBe("question_closed");
  });
});
