import { describe, expect, it, vi } from "vitest";
import { createInMemoryRuntime } from "../../../src/runtime/create-in-memory-runtime.js";
import { createInMemoryWorld } from "../../../src/application/in-memory-world.js";
import { InMemoryWorkRetrospectivePolicyStore } from "../../../src/application/work-retrospective-policy.js";
import { SchedulerService } from "../../../src/application/scheduler-service.js";
import { createTelegramScheduledActionRunner } from "../../../src/runtime/scheduled-action-delivery.js";
import { PersonalAssistantService } from "../../../src/application/personal-assistant-service.js";

const start = "2026-08-26T12:00:00.000Z";
function fixture() {
  let now = start;
  const world = createInMemoryWorld(() => now);
  world.participants.push({ employeeId: "e", companyId: "c", groupId: "g", subjectKey: "s", roleId: "r", status: "profile_completed", createdAt: start, updatedAt: start });
  world.profiles.push({ employeeId: "e", companyId: "c", groupId: "g", roleId: "r", preferredName: "Test", assistantName: "Test", addressForm: "formal", persona: "support", responseLength: "short", timezone: "Etc/UTC", createdAt: start, updatedAt: start });
  const policies = new InMemoryWorkRetrospectivePolicyStore([{ companyId: "c", groupId: "g", enabled: true, period: { start: "2026-08-01T00:00:00.000Z", end: "2026-09-01T00:00:00.000Z" }, methodVersion: "v1" }]);
  const make = () => createInMemoryRuntime({ world, agentRunner: async () => "unused", workRetrospectivePolicies: policies,
    assistantAgentRunner: async (_, context) => {
      if (!context.workRetrospective?.scheduled) await context.workRetrospective!.update({ question: { text: "Pending?", stage: "actions" } });
      else if (context.workRetrospective.scheduled.retrospectiveTouch?.preservePendingQuestion) {
        expect(await context.workRetrospective.update({ question: { text: "Replacement?", stage: "value" } })).toEqual({ status: "forbidden" });
        expect(context.workRetrospective.scheduled.retrospectiveTouch.mode).toBe("continue");
      }
      return { text: "Pending?", executionTrace: [] };
    } });
  const runtime = make();
  const send = vi.fn(async (_chat: string, result: Awaited<ReturnType<PersonalAssistantService["runScheduledProcess"]>>) => {
    await runtime.responseDelivery.record({ employeeId: "e", threadId: "t", messageId: result.messageId, status: "delivered" });
  });
  const compose = (r = runtime) => {
    const assistant = { runScheduledProcess: (input: Parameters<PersonalAssistantService["runScheduledProcess"]>[0]) =>
      PersonalAssistantService.prototype.runScheduledProcess.call({ conversationService: r.assistantChat } as unknown as PersonalAssistantService, input) };
    return new SchedulerService(r.scheduleStore, { now: () => now }, createTelegramScheduledActionRunner({ assistant,
      telegramSessionStore: r.telegramSessionStore, telegramShell: { deliverProactive: send, deliverReminder: async () => undefined } }), undefined, r.touchPolicy);
  };
  return { runtime, world, make, compose, send, setNow: (value: string) => { now = value; } };
}

describe("trusted retrospective scheduler composition", () => {
  it.each(["weekly_summary", "final_report"])("delivered %s replaces evening and restart replay is suppressed", async (processId) => {
    const f = fixture();
    await f.runtime.telegramSessionStore.claim({ identity: { chatId: "chat" }, session: { employeeId: "e", threadId: "t", createdAt: start, updatedAt: start } });
    const scheduler = f.compose();
    await scheduler.saveDailySchedule("e", { id: "summary", processId, timeOfDay: "17:00", timezone: "Etc/UTC", enabled: true });
    await scheduler.saveDailySchedule("e", { id: "evening", processId: "evening_reflection", timeOfDay: "19:00", timezone: "Etc/UTC", enabled: true });
    f.setNow("2026-08-26T17:00:00.000Z"); await scheduler.tick();
    const restarted = f.make();
    await restarted.telegramSessionStore.claim({ identity: { chatId: "chat" }, session: { employeeId: "e", threadId: "t", createdAt: start, updatedAt: start } });
    expect(await restarted.touchPolicy({ kind: "process", userId: "e", processId, scheduleId: "summary", scheduledFor: "2026-08-26T17:00:00.000Z" } as Parameters<typeof restarted.touchPolicy>[0])).toEqual({ action: "suppress", reason: "already_delivered" });
    f.setNow("2026-08-26T19:00:00.000Z"); await f.compose(restarted).tick();
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.world.messages[0]?.metadata?.scheduledProvenance).toMatchObject({ processId, scheduleId: "summary", retrospectiveTouch: { mode: "invite" } });
  });
  it.each(["generated", "failed", "disabled"])("%s summary does not suppress evening", async (status) => {
    const f = fixture();
    await f.runtime.telegramSessionStore.claim({ identity: { chatId: "chat" }, session: { employeeId: "e", threadId: "t", createdAt: start, updatedAt: start } });
    if (status !== "disabled") {
      const result = await f.runtime.assistantChat!.chat({ userId: "e", threadId: "t", text: "summary", requiredProcessId: "weekly_summary",
        scheduledProvenance: { processId: "weekly_summary", scheduleId: "weekly", scheduledFor: start } });
      if (status === "failed") await f.runtime.responseDelivery.record({ employeeId: "e", threadId: "t", messageId: result.messageId, status: "failed" });
    }
    const scheduler = f.compose();
    await scheduler.saveDailySchedule("e", { id: "evening", processId: "evening_reflection", timeOfDay: "19:00", timezone: "Etc/UTC", enabled: true });
    f.setNow("2026-08-26T19:00:00.000Z"); await scheduler.tick();
    expect(f.send).toHaveBeenCalledTimes(1);
  });
  it("scheduled continuation preserves the pending question through AssistantService", async () => {
    const f = fixture();
    await f.runtime.telegramSessionStore.claim({ identity: { chatId: "chat" }, session: { employeeId: "e", threadId: "t", createdAt: start, updatedAt: start } });
    await f.runtime.assistantChat!.chat({ userId: "e", threadId: "t", text: "Fact" });
    const scheduler = f.compose();
    await scheduler.saveDailySchedule("e", { id: "evening", processId: "evening_reflection", timeOfDay: "19:00", timezone: "Etc/UTC", enabled: true });
    f.setNow("2026-08-26T19:00:00.000Z"); await scheduler.tick();
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.world.messages[1]?.metadata?.scheduledProvenance?.retrospectiveTouch?.preservePendingQuestion).toBe(true);
  });
});
