import { describe, expect, it } from "vitest";
import { createInMemoryScheduleStore } from "../../../src/application/in-memory-schedule-store.js";
import { SchedulerService } from "../../../src/application/scheduler-service.js";
import { nextDailyFireAt, normalizeDaysOfWeek } from "../../../src/shared/schedule-time.js";
import { requireTelegramDeliverySession } from "../../../src/telegram/telegram-session-store.js";
import { createInMemoryRuntime } from "../../../src/runtime/create-in-memory-runtime.js";
import { createInMemoryWorld } from "../../../src/application/in-memory-world.js";
import { DefaultScheduleProvisioner } from "../../../src/application/default-schedules.js";
import type { AssistantChatResult } from "../../../src/application/assistant-service.js";
import { renderTelegramMarkdown } from "../../../src/telegram/telegram-renderer.js";
import { createTelegramScheduledActionRunner } from "../../../src/runtime/scheduled-action-delivery.js";

class TelegramUnavailableError extends Error {
  constructor() { super("Telegram is unavailable"); this.name = "TelegramUnavailableError"; }
}

describe("SPEC-PERSONAL-ASSISTANT-SCHEDULER-001: durable slim scheduler", () => {
  it("provisions owner-prefixed defaults from each completed profile timezone without overwriting personal changes", async () => {
    const now = "2026-01-15T05:30:00.000Z";
    const runtime = createInMemoryRuntime({
      world: createInMemoryWorld(() => now),
      agentRunner: async () => "Добро пожаловать!",
    });
    await onboard(runtime, "owner_moscow", "Europe/Moscow");
    await onboard(runtime, "owner_tokyo", "Asia/Tokyo");

    await expect(runtime.scheduleStore.list("owner_moscow")).resolves.toMatchObject([
      { id: "owner_moscow:morning_activity_collection-daily", processId: "morning_activity_collection", timeOfDay: "08:30", daysOfWeek: 31, timezone: "Europe/Moscow", nextFireAt: "2026-01-16T05:30:00.000Z" },
      { id: "owner_moscow:evening_reflection-daily", processId: "evening_reflection", timeOfDay: "19:00", daysOfWeek: 31, timezone: "Europe/Moscow", nextFireAt: "2026-01-15T16:00:00.000Z" },
    ]);
    await expect(runtime.scheduleStore.list("owner_tokyo")).resolves.toMatchObject([
      { id: "owner_tokyo:morning_activity_collection-daily", processId: "morning_activity_collection", timeOfDay: "08:30", daysOfWeek: 31, timezone: "Asia/Tokyo", nextFireAt: "2026-01-15T23:30:00.000Z" },
      { id: "owner_tokyo:evening_reflection-daily", processId: "evening_reflection", timeOfDay: "19:00", daysOfWeek: 31, timezone: "Asia/Tokyo", nextFireAt: "2026-01-15T10:00:00.000Z" },
    ]);
    await expect(runtime.scheduleStore.list("other_owner")).resolves.toEqual([]);

    await runtime.scheduleStore.save("owner_moscow", {
      id: "owner_moscow:morning_activity_collection-daily", processId: "morning_activity_collection", timeOfDay: "10:30", timezone: "Europe/Moscow",
      enabled: false, nextFireAt: "2026-01-15T07:30:00.000Z",
    });
    await expect(runtime.service.completeOnboarding({ employeeId: "owner_moscow", roleId: "default_role", persona: "efficiency", timezone: "Europe/Moscow" })).resolves.toMatchObject({ completion: "already" });
    const restartedProvisioner = new DefaultScheduleProvisioner(runtime.scheduleStore, { now: () => "2026-01-16T05:30:00.000Z" });
    await expect(restartedProvisioner.provision("owner_moscow", "Europe/Moscow")).resolves.toMatchObject({
      created: false,
      schedules: [
        { id: "owner_moscow:morning_activity_collection-daily", timeOfDay: "10:30", enabled: false, nextFireAt: "2026-01-15T07:30:00.000Z" },
        { id: "owner_moscow:evening_reflection-daily", timeOfDay: "19:00", daysOfWeek: 31, enabled: true },
      ],
    });
    await expect(runtime.scheduleStore.list("owner_moscow")).resolves.toMatchObject([
      { id: "owner_moscow:morning_activity_collection-daily", timeOfDay: "10:30", enabled: false, nextFireAt: "2026-01-15T07:30:00.000Z" },
      { id: "owner_moscow:evening_reflection-daily", timeOfDay: "19:00", daysOfWeek: 31, enabled: true },
    ]);
  });

  it("roundtrips expanded schedule fields and copies the action into the fire ledger", async () => {
    const clock = { now: () => "2026-07-30T06:00:00.000Z" };
    const store = createInMemoryScheduleStore(clock);
    await expect(store.save("maxim", {
      id: "weekly-reminder", daysOfWeek: 5, kind: "reminder", reminderText: "Позвонить маме", oneShot: true,
      timeOfDay: "09:00", timezone: "Europe/Moscow", enabled: true, nextFireAt: clock.now(),
    })).resolves.toMatchObject({
      daysOfWeek: 5, kind: "reminder", reminderText: "Позвонить маме", oneShot: true,
    });

    await expect(store.claimDue(clock.now())).resolves.toMatchObject([{
      scheduleId: "weekly-reminder", daysOfWeek: 5, kind: "reminder", reminderText: "Позвонить маме", oneShot: true,
    }]);
  });

  it("defaults existing process writes to every day and recurring behavior", async () => {
    const clock = { now: () => "2026-07-30T06:00:00.000Z" };
    const store = createInMemoryScheduleStore(clock);
    await expect(store.save("maxim", {
      id: "legacy-process", processId: "day_focus", timeOfDay: "09:00", timezone: "Europe/Moscow",
      enabled: true, nextFireAt: clock.now(),
    })).resolves.toMatchObject({ daysOfWeek: 127, kind: "process", processId: "day_focus", oneShot: false });
    await expect(store.claimDue(clock.now())).resolves.toMatchObject([{
      daysOfWeek: 127, kind: "process", processId: "day_focus", oneShot: false,
    }]);
  });

  it("materializes one due fire and does not duplicate it on repeated ticks or service restart", async () => {
    let now = "2026-07-30T05:59:00.000Z";
    const clock = { now: () => now };
    const store = createInMemoryScheduleStore(clock);
    const scheduler = new SchedulerService(store, clock);

    await expect(scheduler.saveDailySchedule("maxim", {
      id: "morning-focus",
      processId: "day_focus",
      timeOfDay: "09:00",
      timezone: "Europe/Moscow",
    })).resolves.toMatchObject({ nextFireAt: "2026-07-30T06:00:00.000Z", timezone: "Europe/Moscow" });

    now = "2026-07-30T06:00:00.000Z";
    await expect(scheduler.tick()).resolves.toMatchObject([{
      scheduleId: "morning-focus", userId: "maxim", processId: "day_focus",
      scheduledFor: "2026-07-30T06:00:00.000Z", status: "pending",
    }]);
    await expect(scheduler.tick()).resolves.toHaveLength(1);

    const restarted = new SchedulerService(store, clock);
    await expect(restarted.tick()).resolves.toHaveLength(1);
    await expect(store.listFires("maxim", "morning-focus")).resolves.toHaveLength(1);
    await expect(store.get("maxim", "morning-focus")).resolves.toMatchObject({
      nextFireAt: "2026-07-31T06:00:00.000Z",
    });

    await expect(store.completeFire("maxim", {
      scheduleId: "morning-focus",
      scheduledFor: "2026-07-30T06:00:00.000Z",
      status: "succeeded",
    })).resolves.toMatchObject({ status: "succeeded" });
    await expect(restarted.tick()).resolves.toEqual([]);
  });

  it("delivers an owner reminder without calling the agent or recording usage", async () => {
    const clock = { now: () => "2026-07-30T06:00:00.000Z" };
    const store = createInMemoryScheduleStore(clock);
    let agentCalls = 0;
    const usageRecords: unknown[] = [];
    const deliveries: Array<{ chatId: string; userId: string; text: string }> = [];
    const runner = createTelegramScheduledActionRunner({
      assistant: {
        async runScheduledProcess() {
          agentCalls += 1;
          usageRecords.push({ source: "chat" });
          throw new Error("agent must not run for reminders");
        },
      },
      telegramSessionStore: {
        async getDeliveryByEmployee(userId) {
          return userId === "maxim"
            ? { employeeId: userId, chatId: "owner-chat", threadId: "owner-thread", createdAt: clock.now(), updatedAt: clock.now() }
            : undefined;
        },
      },
      telegramShell: {
        async deliverProactive() { throw new Error("proactive process delivery must not run for reminders"); },
        async deliverReminder(chatId, text, userId) { deliveries.push({ chatId, userId, text }); },
      },
    });
    const scheduler = new SchedulerService(store, clock, runner);
    await store.save("maxim", {
      id: "drink-water", kind: "reminder", reminderText: "Выпить <воды> & отдохнуть", oneShot: false,
      timeOfDay: "09:00", timezone: "Europe/Moscow", enabled: true, nextFireAt: clock.now(),
    });

    await expect(scheduler.tick()).resolves.toMatchObject([{ kind: "reminder", reminderText: "Выпить <воды> & отдохнуть" }]);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toEqual({
      chatId: "owner-chat",
      userId: "maxim",
      text: "Выпить <воды> & отдохнуть",
    });
    expect(agentCalls).toBe(0);
    expect(usageRecords).toEqual([]);
    expect(renderTelegramMarkdown(deliveries[0]!.text)).toEqual([{
      text: "Выпить &lt;воды&gt; &amp; отдохнуть",
      parseMode: "HTML",
    }]);
    await expect(store.listFires("maxim", "drink-water")).resolves.toMatchObject([{ status: "succeeded" }]);
  });

  it("logs reminder delivery failure and leaves the schedule enabled", async () => {
    const clock = { now: () => "2026-07-30T06:00:00.000Z" };
    const store = createInMemoryScheduleStore(clock);
    const logged: Array<{ errorCode: string; kind: string }> = [];
    const scheduler = new SchedulerService(
      store,
      clock,
      async () => { throw new TelegramUnavailableError(); },
      ({ fire, errorCode }) => logged.push({ errorCode, kind: fire.kind }),
    );
    await store.save("maxim", {
      id: "failed-reminder", kind: "reminder", reminderText: "Позвонить маме", oneShot: true,
      timeOfDay: "09:00", timezone: "Europe/Moscow", enabled: true, nextFireAt: clock.now(),
    });

    await expect(scheduler.tick()).resolves.toHaveLength(1);
    expect(logged).toEqual([{ errorCode: "TelegramUnavailableError", kind: "reminder" }]);
    await expect(store.listFires("maxim", "failed-reminder")).resolves.toMatchObject([{
      status: "failed", errorCode: "TelegramUnavailableError",
    }]);
    await expect(store.get("maxim", "failed-reminder")).resolves.toMatchObject({ enabled: true });
  });

  it("disables a successful one-shot reminder and excludes it from the next claim", async () => {
    let now = "2026-07-30T06:00:00.000Z";
    const clock = { now: () => now };
    const store = createInMemoryScheduleStore(clock);
    const deliveries: string[] = [];
    const scheduler = new SchedulerService(store, clock, async (fire) => {
      if (fire.kind === "reminder") deliveries.push(fire.text);
    });
    await store.save("maxim", {
      id: "zoom-once", kind: "reminder", reminderText: "Подключиться к зуму", oneShot: true,
      timeOfDay: "09:00", timezone: "Europe/Moscow", enabled: true, nextFireAt: clock.now(),
    });

    await expect(scheduler.tick()).resolves.toHaveLength(1);
    expect(deliveries).toEqual(["Подключиться к зуму"]);
    await expect(store.get("maxim", "zoom-once")).resolves.toMatchObject({ enabled: false, oneShot: true });
    now = "2026-07-31T06:00:00.000Z";
    await expect(scheduler.tick()).resolves.toEqual([]);
  });

  it("leaves a one-shot fire pending and the schedule enabled when disabling fails", async () => {
    const clock = { now: () => "2026-07-30T06:00:00.000Z" };
    const base = createInMemoryScheduleStore(clock);
    const store = {
      ...base,
      async save(userId: string, input: Parameters<typeof base.save>[1]) {
        if (!input.enabled) throw new Error("disable failed");
        return base.save(userId, input);
      },
    };
    const scheduler = new SchedulerService(store, clock, async () => undefined);
    await base.save("maxim", {
      id: "zoom-disable-fails", kind: "reminder", reminderText: "Подключиться к зуму", oneShot: true,
      timeOfDay: "09:00", timezone: "Europe/Moscow", enabled: true, nextFireAt: clock.now(),
    });

    await expect(scheduler.tick()).resolves.toHaveLength(1);
    await expect(base.listFires("maxim", "zoom-disable-fails")).resolves.toMatchObject([{
      status: "failed", errorCode: "Error",
    }]);
    await expect(base.get("maxim", "zoom-disable-fails")).resolves.toMatchObject({ enabled: true });
  });

  it("delivers only the claimed reminder owner and keeps another owner isolated", async () => {
    const clock = { now: () => "2026-07-30T06:00:00.000Z" };
    const store = createInMemoryScheduleStore(clock);
    const deliveries: Array<{ userId: string; text: string }> = [];
    const scheduler = new SchedulerService(store, clock, async (fire) => {
      if (fire.kind === "reminder") deliveries.push({ userId: fire.userId, text: fire.text });
    });
    await store.save("owner-a", {
      id: "owner-a-reminder", kind: "reminder", reminderText: "Секрет владельца A", oneShot: false,
      timeOfDay: "09:00", timezone: "Europe/Moscow", enabled: true, nextFireAt: clock.now(),
    });
    await store.save("owner-b", {
      id: "owner-b-reminder", kind: "reminder", reminderText: "Секрет владельца B", oneShot: false,
      timeOfDay: "10:00", timezone: "Europe/Moscow", enabled: true, nextFireAt: "2026-07-30T07:00:00.000Z",
    });

    await expect(scheduler.tick()).resolves.toHaveLength(1);
    expect(deliveries).toEqual([{ userId: "owner-a", text: "Секрет владельца A" }]);
    await expect(store.listFires("owner-a")).resolves.toHaveLength(1);
    await expect(store.listFires("owner-b")).resolves.toEqual([]);
    await expect(store.list("owner-b")).resolves.toMatchObject([{ reminderText: "Секрет владельца B" }]);
  });

  it("runs morning_activity_collection through the deterministic facade trigger and records a successful outcome", async () => {
    const clock = { now: () => "2026-07-30T06:00:00.000Z" };
    const store = createInMemoryScheduleStore(clock);
    const facadeCalls: Array<{ userId: string; threadId: string; processId: string }> = [];
    const deliveries: Array<{ chatId: string; employeeId: string; result: AssistantChatResult }> = [];
    const result: AssistantChatResult = { messageId: "scheduled-message", response: "Расскажите об одной-трёх активностях.", selectedProcessIds: ["core", "morning_activity_collection"], outcome: { status: "completed" }, effect: "none", pendingActions: [] };
    const facade = {
      async runScheduledProcess(input: { userId: string; threadId: string; processId: "morning_activity_collection" }) {
        facadeCalls.push(input);
        return result;
      },
    };
    const telegramShell = { async deliverProactive(chatId: string, delivered: AssistantChatResult, employeeId: string) { deliveries.push({ chatId, employeeId, result: delivered }); } };
    const scheduler = new SchedulerService(store, clock, async (fire) => {
      if (fire.kind !== "process") throw new Error("unexpected reminder action");
      const scheduled = await facade.runScheduledProcess({ userId: fire.userId, threadId: "owner-thread", processId: fire.processId as "morning_activity_collection" });
      await telegramShell.deliverProactive("owner-chat", scheduled, fire.userId);
    });
    await store.save("maxim", {
      id: "morning-touch", processId: "morning_activity_collection", timeOfDay: "09:00", timezone: "Europe/Moscow",
      enabled: true, nextFireAt: clock.now(),
    });

    await expect(scheduler.tick()).resolves.toMatchObject([{ processId: "morning_activity_collection", status: "pending" }]);
    expect(facadeCalls).toEqual([{ userId: "maxim", threadId: "owner-thread", processId: "morning_activity_collection" }]);
    expect(deliveries).toEqual([{ chatId: "owner-chat", employeeId: "maxim", result }]);
    await expect(store.listFires("maxim", "morning-touch")).resolves.toMatchObject([{
      status: "succeeded", completedAt: clock.now(),
    }]);
  });

  it("runs evening_reflection through the same facade and Telegram delivery path", async () => {
    const clock = { now: () => "2026-07-30T16:00:00.000Z" };
    const store = createInMemoryScheduleStore(clock);
    const facadeCalls: Array<{ userId: string; threadId: string; processId: string }> = [];
    const deliveries: Array<{ chatId: string; employeeId: string; result: AssistantChatResult }> = [];
    const result: AssistantChatResult = { messageId: "scheduled-evening-message", response: "Как прошёл день? Что получилось, что помешало и какой один шаг перенесём на завтра?", selectedProcessIds: ["core", "evening_reflection"], outcome: { status: "completed" }, effect: "none", pendingActions: [] };
    const facade = {
      async runScheduledProcess(input: { userId: string; threadId: string; processId: "evening_reflection" }) {
        facadeCalls.push(input);
        return result;
      },
    };
    const telegramShell = { async deliverProactive(chatId: string, delivered: AssistantChatResult, employeeId: string) { deliveries.push({ chatId, employeeId, result: delivered }); } };
    const scheduler = new SchedulerService(store, clock, async (fire) => {
      if (fire.kind !== "process") throw new Error("unexpected reminder action");
      const scheduled = await facade.runScheduledProcess({ userId: fire.userId, threadId: "owner-thread", processId: fire.processId as "evening_reflection" });
      await telegramShell.deliverProactive("owner-chat", scheduled, fire.userId);
    });
    await store.save("maxim", {
      id: "evening-reflection", processId: "evening_reflection", timeOfDay: "19:00", timezone: "Europe/Moscow",
      enabled: true, nextFireAt: clock.now(),
    });

    await expect(scheduler.tick()).resolves.toMatchObject([{ processId: "evening_reflection", status: "pending" }]);
    expect(facadeCalls).toEqual([{ userId: "maxim", threadId: "owner-thread", processId: "evening_reflection" }]);
    expect(deliveries).toEqual([{ chatId: "owner-chat", employeeId: "maxim", result }]);
    await expect(store.listFires("maxim", "evening-reflection")).resolves.toMatchObject([{
      status: "succeeded", completedAt: clock.now(),
    }]);
  });

  it("marks a missing Telegram delivery target without rejecting the scheduler tick", async () => {
    const clock = { now: () => "2026-07-30T06:00:00.000Z" };
    const store = createInMemoryScheduleStore(clock);
    const logged: Array<{ errorCode: string; processId: string | undefined }> = [];
    const scheduler = new SchedulerService(
      store,
      clock,
      async () => { requireTelegramDeliverySession(undefined); },
      ({ fire, errorCode }) => logged.push({ errorCode, processId: fire.processId }),
    );
    await store.save("maxim", {
      id: "morning-touch", processId: "morning_activity_collection", timeOfDay: "09:00", timezone: "Europe/Moscow",
      enabled: true, nextFireAt: clock.now(),
    });

    await expect(scheduler.tick()).resolves.toHaveLength(1);
    expect(logged).toEqual([{ errorCode: "TelegramDeliverySessionNotFoundError", processId: "morning_activity_collection" }]);
    await expect(store.listFires("maxim", "morning-touch")).resolves.toMatchObject([{
      status: "failed", errorCode: "TelegramDeliverySessionNotFoundError", completedAt: clock.now(),
    }]);
  });

  it("marks Telegram delivery failure without rejecting the scheduler tick", async () => {
    const clock = { now: () => "2026-07-30T06:00:00.000Z" };
    const store = createInMemoryScheduleStore(clock);
    const logged: Array<{ errorCode: string; processId: string | undefined }> = [];
    const scheduler = new SchedulerService(
      store,
      clock,
      async () => { throw new TelegramUnavailableError(); },
      ({ fire, errorCode }) => logged.push({ errorCode, processId: fire.processId }),
    );
    await store.save("maxim", {
      id: "morning-touch", processId: "morning_activity_collection", timeOfDay: "09:00", timezone: "Europe/Moscow",
      enabled: true, nextFireAt: clock.now(),
    });

    await expect(scheduler.tick()).resolves.toHaveLength(1);
    expect(logged).toEqual([{ errorCode: "TelegramUnavailableError", processId: "morning_activity_collection" }]);
    await expect(store.listFires("maxim", "morning-touch")).resolves.toMatchObject([{
      status: "failed", errorCode: "TelegramUnavailableError", completedAt: clock.now(),
    }]);
  });

  it("advances a stale schedule to the next future wall-clock occurrence without catch-up floods", async () => {
    const clock = { now: () => "2026-08-02T06:00:00.000Z" };
    const store = createInMemoryScheduleStore(clock);
    await store.save("maxim", {
      id: "stale", processId: "day_focus", timeOfDay: "09:00", timezone: "Europe/Moscow",
      enabled: true, nextFireAt: "2026-07-30T06:00:00.000Z",
    });

    await expect(store.claimDue(clock.now())).resolves.toHaveLength(1);
    await expect(store.get("maxim", "stale")).resolves.toMatchObject({ nextFireAt: "2026-08-03T06:00:00.000Z" });
    await expect(store.claimDue(clock.now())).resolves.toHaveLength(1);
    await expect(store.listFires("maxim", "stale")).resolves.toHaveLength(1);
  });

  it("calculates the next occurrence in the owner's IANA timezone", () => {
    expect(nextDailyFireAt({
      after: "2026-01-15T05:30:00.000Z",
      timeOfDay: "09:00",
      timezone: "Europe/Moscow",
    })).toBe("2026-01-15T06:00:00.000Z");
    expect(nextDailyFireAt({
      after: "2026-01-15T06:00:00.000Z",
      timeOfDay: "09:00",
      timezone: "Europe/Moscow",
    })).toBe("2026-01-16T06:00:00.000Z");
    expect(nextDailyFireAt({
      after: "2026-01-15T16:00:00.000Z",
      timeOfDay: "09:00",
      timezone: "Asia/Tokyo",
    })).toBe("2026-01-16T00:00:00.000Z");
  });

  it("selects only weekdays allowed by the local day-of-week mask", () => {
    expect(nextDailyFireAt({
      after: "2026-07-31T07:00:00.000Z",
      timeOfDay: "09:00",
      timezone: "Europe/Moscow",
      daysOfWeek: 0b0011111,
    })).toBe("2026-08-03T06:00:00.000Z");
    expect(nextDailyFireAt({
      after: "2026-07-29T07:00:00.000Z",
      timeOfDay: "09:00",
      timezone: "Europe/Moscow",
      daysOfWeek: 0b1000000,
    })).toBe("2026-08-02T06:00:00.000Z");
    expect(nextDailyFireAt({
      after: "2026-08-01T07:00:00.000Z",
      timeOfDay: "09:00",
      timezone: "Europe/Moscow",
      daysOfWeek: 0b0000010,
    })).toBe("2026-08-04T06:00:00.000Z");
  });

  it("uses today's allowed occurrence when still ahead and waits seven days after it passes", () => {
    expect(nextDailyFireAt({
      after: "2026-07-29T05:30:00.000Z",
      timeOfDay: "09:00",
      timezone: "Europe/Moscow",
      daysOfWeek: 0b0000100,
    })).toBe("2026-07-29T06:00:00.000Z");
    expect(nextDailyFireAt({
      after: "2026-07-29T06:00:00.000Z",
      timeOfDay: "09:00",
      timezone: "Europe/Moscow",
      daysOfWeek: 0b0000100,
    })).toBe("2026-08-05T06:00:00.000Z");
  });

  it("keeps the all-days mask backward compatible and rejects invalid masks", () => {
    const input = { after: "2026-01-15T06:00:00.000Z", timeOfDay: "09:00", timezone: "Europe/Moscow" };
    expect(nextDailyFireAt(input)).toBe(nextDailyFireAt({ ...input, daysOfWeek: 127 }));
    expect(normalizeDaysOfWeek(undefined)).toBe(127);
    expect(() => normalizeDaysOfWeek(0)).toThrow("daysOfWeek must be between 1 and 127");
    expect(() => normalizeDaysOfWeek(128)).toThrow("daysOfWeek must be between 1 and 127");
    expect(() => normalizeDaysOfWeek(1.5)).toThrow("daysOfWeek must be between 1 and 127");
  });

  it("advances due schedules according to their day-of-week mask", async () => {
    const clock = { now: () => "2026-07-31T06:00:00.000Z" };
    const store = createInMemoryScheduleStore(clock);
    await store.save("maxim", {
      id: "weekday-focus", daysOfWeek: 0b0011111, processId: "day_focus",
      timeOfDay: "09:00", timezone: "Europe/Moscow", enabled: true, nextFireAt: clock.now(),
    });

    await expect(store.claimDue(clock.now())).resolves.toHaveLength(1);
    await expect(store.get("maxim", "weekday-focus")).resolves.toMatchObject({ nextFireAt: "2026-08-03T06:00:00.000Z" });
  });

  it("keeps schedule and fire records owner-scoped", async () => {
    const clock = { now: () => "2026-07-30T06:00:00.000Z" };
    const store = createInMemoryScheduleStore(clock);
    await store.save("maxim", { id: "schedule-1", processId: "day_focus", timeOfDay: "09:00", timezone: "Europe/Moscow", enabled: true, nextFireAt: clock.now() });
    await store.claimDue(clock.now());

    await expect(store.get("other", "schedule-1")).resolves.toBeNull();
    await expect(store.list("other")).resolves.toEqual([]);
    await expect(store.listFires("other")).resolves.toEqual([]);
    await expect(store.completeFire("other", { scheduleId: "schedule-1", scheduledFor: clock.now(), status: "succeeded" })).resolves.toBeNull();
  });
});

async function onboard(runtime: ReturnType<typeof createInMemoryRuntime>, employeeId: string, timezone: string): Promise<void> {
  await runtime.service.issueInvite({ employeeId, inviteCode: `invite_${employeeId}`, companyId: "default_company", groupId: "default_group" });
  await runtime.service.openInvite({ inviteCode: `invite_${employeeId}` });
  await runtime.service.acceptConsent({ employeeId, accepted: true, source: "test" });
  await runtime.service.completeOnboarding({ employeeId, roleId: "default_role", persona: "efficiency", timezone });
}
