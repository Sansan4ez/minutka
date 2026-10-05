import { describe, expect, it } from "vitest";
import { createInMemoryWorld } from "../../../src/application/in-memory-world.js";
import { createInMemoryRuntime } from "../../../src/runtime/create-in-memory-runtime.js";
import type { AssistantAgentRunner } from "../../../src/application/assistant-service.js";
import { createInMemoryConversationStore } from "../../../src/application/in-memory-conversation-store.js";
import { createInMemoryWorkRetrospectiveStore } from "../../../src/application/in-memory-work-retrospective-store.js";
import { createInMemoryProfileStore } from "../../../src/application/in-memory-profile-store.js";
import { createRetrospectiveDelivery } from "../../../src/application/retrospective-delivery.js";
import { weeklyActivitySummarySchema } from "../../../src/mastra/tools/weekly-activity-tool.js";
import { cycleActivitySummarySchema } from "../../../src/mastra/tools/cycle-activity-tool.js";

function fixture() {
  let now = "2026-08-26T12:00:00.000Z";
  let command: Parameters<NonNullable<Parameters<AssistantAgentRunner>[1]["workRetrospective"]>["update"]>[0] = {};
  const world = createInMemoryWorld(() => now);
  world.tenantDirectories.groups = [{ id: "g", companyId: "c", period: { start: "2026-08-20", end: "2026-09-09" } }];
  world.participants.push({ employeeId: "e", companyId: "c", groupId: "g", subjectKey: "subject_e", roleId: "r", status: "profile_completed", createdAt: now, updatedAt: now });
  world.profiles.push({ employeeId: "e", companyId: "c", groupId: "g", roleId: "r", preferredName: "Анна", assistantName: "Минутка", addressForm: "formal", persona: "support", responseLength: "short", timezone: "Etc/UTC", createdAt: now, updatedAt: now });
  let outcome: unknown;
  let weekly: unknown;
  let cycle: unknown;
  const runner: AssistantAgentRunner = async (_, context) => {
    weekly = await context.readWeeklyActivities();
    cycle = await context.readCycleActivities();
    if (context.workRetrospective) outcome = await context.workRetrospective.update(command);
    return { text: command.question?.text ?? "Принято", executionTrace: [] };
  };
  let runtime = createInMemoryRuntime({ world, agentRunner: async () => "unused", assistantAgentRunner: runner });
  return {
    world, setNow(value: string) { now = value; }, restart() { runtime = createInMemoryRuntime({ world, agentRunner: async () => "unused", assistantAgentRunner: runner }); },
    async chat(value: typeof command, scheduled = false) {
      now = new Date(Date.parse(now) + 1000).toISOString();
      command = value;
      await runtime.assistantChat!.chat({ userId: "e", threadId: "t", text: scheduled ? "Недельная сводка" : "Да, продолжим недельный разбор", ...(scheduled ? { requiredProcessId: "weekly_summary" as const } : {}) });
      return outcome;
    },
    summaries: () => ({ weekly: weeklyActivitySummarySchema.parse(weekly), cycle: cycleActivitySummarySchema.parse(cycle) }),
    async deliver() {
      now = new Date(Date.parse(now) + 1000).toISOString();
      const canonical = createInMemoryConversationStore(world);
      const delivery = createRetrospectiveDelivery({ canonical, episodes: createInMemoryWorkRetrospectiveStore(canonical), profiles: createInMemoryProfileStore(world), now: () => now });
      const turn = world.messages.at(-1)!;
      expect(await delivery.record({ employeeId: "e", threadId: "t", messageId: turn.id, status: "delivered" })).toMatchObject({ status: "applied" });
    },
  };
}
const question = { text: "Что вы наблюдали?", stage: "actions" as const };
describe("composed retrospective summary and weekly consent", () => {
  it("01/05 preserves counted facts and historical intentions; follow-up needs separate consent", async () => {
    const f = fixture();
    await f.chat({ selectedStep: "Проверять отчёт", indicator: { sign: "Ошибки", meaning: "Качество", reaction: "Проверить" } });
    await f.chat({});
    expect(f.summaries().weekly.retrospective?.episodes[0]?.followUp).toBeUndefined();
    await f.chat({ followUpConsent: true });
    await f.chat({});
    const before = f.summaries();
    expect(before.weekly.retrospective?.episodes[0]?.followUp?.step.text).toBe("Проверять отчёт");
    f.setNow("2026-09-12T12:00:00.000Z");
    await f.chat({});
    const final = f.summaries().cycle;
    expect(final.activityCount).toBe(0);
    expect(final.sufficientData).toBe(false);
    expect(final.retrospective?.episodes[0]?.tried).toEqual([]);
    expect(final.retrospective?.episodes[0]?.intentions[0]?.text).toBe("Проверять отчёт");
    expect(f.world.messages.at(-1)?.metadata?.retrospectiveEvents).toBeUndefined();
  });
  it("02 synthetic invitation and follow-up permission do not grant weekly consent", async () => {
    const f = fixture();
    expect(await f.chat({ weeklyConsent: true }, true)).toMatchObject({ status: "forbidden" });
    await f.chat({ followUpConsent: true, question });
    await f.deliver();
    for (let i = 1; i < 4; i++) { await f.chat({ closeReason: "answered", question }); await f.deliver(); }
    await f.chat({ closeReason: "answered", question });
    expect(f.world.messages.at(-1)?.metadata?.retrospectiveEvents).toBeUndefined();
  });
  it("03 eight delivered questions survive restart, next day daily and next week new consent", async () => {
    const f = fixture();
    await f.chat({ weeklyConsent: true, question }); await f.deliver();
    for (let i = 1; i < 8; i++) { await f.chat({ closeReason: "answered", question }); await f.deliver(); }
    f.restart();
    await f.chat({ closeReason: "answered", question });
    expect(f.world.messages.at(-1)?.metadata?.retrospectiveEvents).toBeUndefined();
    f.setNow("2026-08-27T12:00:00.000Z");
    await f.chat({ question }); await f.deliver();
    for (let i = 1; i < 4; i++) { await f.chat({ closeReason: "answered", question }); await f.deliver(); }
    await f.chat({ closeReason: "answered", question });
    expect(f.world.messages.at(-1)?.metadata?.retrospectiveEvents).toBeUndefined();
    expect(await f.chat({ weeklyConsent: true })).toMatchObject({ status: "forbidden" });
    f.setNow("2026-08-31T12:00:00.000Z");
    expect(await f.chat({ weeklyConsent: true, question })).toMatchObject({ status: "staged" });
    await f.deliver();
  });
  it("04 decline closes the session without erasing statements or forcing a question", async () => {
    const f = fixture();
    await f.chat({ weeklyConsent: true, statement: { text: "Проверил отчёт", stage: "actions", kind: "employee_fact" }, question });
    await f.deliver();
    await f.chat({ closeReason: "declined", question });
    await f.chat({});
    expect(f.summaries().weekly.retrospective?.episodes[0]?.confirmed[0]?.text).toBe("Проверил отчёт");
    const actions = f.world.messages.at(-2)?.metadata?.retrospectiveEvents?.map((e) => e.action.type);
    expect(actions).toContain("weekly_session_closed");
    expect(actions).not.toContain("question_generated");
    const canonical = createInMemoryConversationStore(f.world);
    expect(await createInMemoryWorkRetrospectiveStore(canonical).readEpisodes({ scope: { employeeId: "other", companyId: "c", groupId: "g", subjectKey: "other", threadId: "t" }, limit: 100 })).toMatchObject({ value: [] });
  });
});
