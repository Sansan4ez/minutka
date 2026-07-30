import { describe, expect, it } from "vitest";
import { createInMemoryScheduleStore } from "../../../src/application/in-memory-schedule-store.js";
import { SchedulerService } from "../../../src/application/scheduler-service.js";
import { nextDailyFireAt } from "../../../src/shared/schedule-time.js";

class TelegramUnavailableError extends Error {
  constructor() { super("Telegram is unavailable"); this.name = "TelegramUnavailableError"; }
}

describe("SPEC-PERSONAL-ASSISTANT-SCHEDULER-001: durable slim scheduler", () => {
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

  it("runs day_focus through the deterministic facade trigger and records a successful outcome", async () => {
    const clock = { now: () => "2026-07-30T06:00:00.000Z" };
    const store = createInMemoryScheduleStore(clock);
    const facadeCalls: Array<{ userId: string; threadId: string; processId: string }> = [];
    const deliveries: Array<{ chatId: string; text: string }> = [];
    const facade = {
      async runScheduledProcess(input: { userId: string; threadId: string; processId: "day_focus" }) {
        facadeCalls.push(input);
        return { response: "Три приоритета и один следующий шаг." };
      },
    };
    const scheduler = new SchedulerService(store, clock, async (fire) => {
      const result = await facade.runScheduledProcess({ userId: fire.userId, threadId: "owner-thread", processId: fire.processId });
      deliveries.push({ chatId: "owner-chat", text: result.response });
    });
    await store.save("maxim", {
      id: "morning-focus", processId: "day_focus", timeOfDay: "09:00", timezone: "Europe/Moscow",
      enabled: true, nextFireAt: clock.now(),
    });

    await expect(scheduler.tick()).resolves.toMatchObject([{ processId: "day_focus", status: "pending" }]);
    expect(facadeCalls).toEqual([{ userId: "maxim", threadId: "owner-thread", processId: "day_focus" }]);
    expect(deliveries).toEqual([{ chatId: "owner-chat", text: "Три приоритета и один следующий шаг." }]);
    await expect(store.listFires("maxim", "morning-focus")).resolves.toMatchObject([{
      status: "succeeded", completedAt: clock.now(),
    }]);
  });

  it("marks Telegram delivery failure without rejecting the scheduler tick", async () => {
    const clock = { now: () => "2026-07-30T06:00:00.000Z" };
    const store = createInMemoryScheduleStore(clock);
    const logged: Array<{ errorCode: string; processId: string }> = [];
    const scheduler = new SchedulerService(
      store,
      clock,
      async () => { throw new TelegramUnavailableError(); },
      ({ fire, errorCode }) => logged.push({ errorCode, processId: fire.processId }),
    );
    await store.save("maxim", {
      id: "morning-focus", processId: "day_focus", timeOfDay: "09:00", timezone: "Europe/Moscow",
      enabled: true, nextFireAt: clock.now(),
    });

    await expect(scheduler.tick()).resolves.toHaveLength(1);
    expect(logged).toEqual([{ errorCode: "TelegramUnavailableError", processId: "day_focus" }]);
    await expect(store.listFires("maxim", "morning-focus")).resolves.toMatchObject([{
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

  it("keeps schedule and fire records owner-scoped", async () => {
    const clock = { now: () => "2026-07-30T06:00:00.000Z" };
    const store = createInMemoryScheduleStore(clock);
    await store.save("maxim", { id: "schedule-1", processId: "day_focus", timeOfDay: "09:00", timezone: "Europe/Moscow", enabled: true, nextFireAt: clock.now() });
    await store.claimDue(clock.now());

    await expect(store.get("other", "schedule-1")).resolves.toBeNull();
    await expect(store.listFires("other")).resolves.toEqual([]);
    await expect(store.completeFire("other", { scheduleId: "schedule-1", scheduledFor: clock.now(), status: "succeeded" })).resolves.toBeNull();
  });
});
