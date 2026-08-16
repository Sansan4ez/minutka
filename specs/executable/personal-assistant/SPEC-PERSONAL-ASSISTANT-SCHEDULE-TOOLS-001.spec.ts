import { describe, expect, it } from "vitest";
import { createInMemoryScheduleStore } from "../../../src/application/in-memory-schedule-store.js";
import { createDeterministicIdGenerator } from "../../../src/application/runtime-primitives.js";
import {
  AssistantScheduleKindChangeError,
  AssistantScheduleNotFoundError,
  ScheduleManagementService,
} from "../../../src/application/schedule-management-service.js";
import { createScheduleTools, scheduleListOutputSchema, scheduleMutationOutputSchema, scheduleViewSchema } from "../../../src/mastra/tools/schedule-tools.js";

const now = "2026-07-30T05:00:00.000Z";

function setup() {
  const clock = { now: () => now };
  const store = createInMemoryScheduleStore(clock);
  const timezones = new Map<string, string>();
  const profiles = {
    async getProfile(employeeId: string) {
      const timezone = timezones.get(employeeId);
      return timezone ? {
        employeeId, companyId: "default_company", groupId: "default_group", roleId: "default_role",
        preferredName: employeeId, assistantName: "Ассистент", addressForm: "informal" as const,
        persona: "efficiency" as const, responseLength: "balanced" as const, timezone, createdAt: now, updatedAt: now,
      } : undefined;
    },
  };
  return { store, timezones, service: new ScheduleManagementService(store, profiles, clock, createDeterministicIdGenerator()) };
}

describe("SPEC-PERSONAL-ASSISTANT-SCHEDULE-TOOLS-001: owner schedule use-cases and tools", () => {
  it("keeps list, save, and disable owner-scoped and recalculates in the profile timezone", async () => {
    const { store, timezones, service } = setup();
    timezones.set("owner-a", "Europe/Moscow");
    timezones.set("owner-b", "Asia/Tokyo");

    const saved = await service.saveDailySchedule("owner-a", { processId: "day_focus", timeOfDay: "08:30" });
    expect(saved).toMatchObject({
      id: "owner-a:day_focus-daily", userId: "owner-a", kind: "process", processId: "day_focus",
      daysOfWeek: 127, oneShot: false, timeOfDay: "08:30", timezone: "Europe/Moscow", enabled: true,
      nextFireAt: "2026-07-30T05:30:00.000Z",
    });
    await service.saveDailySchedule("owner-b", { processId: "evening_reflection", timeOfDay: "20:00" });

    await expect(service.listSchedules("owner-a")).resolves.toMatchObject([{ processId: "day_focus" }]);
    await expect(service.listSchedules("owner-b")).resolves.toMatchObject([{ processId: "evening_reflection" }]);
    await expect(service.disableSchedule("owner-b", saved.id)).resolves.toBeNull();
    await expect(store.get("owner-a", saved.id)).resolves.toMatchObject({ enabled: true });

    await expect(service.disableSchedule("owner-a", saved.id)).resolves.toMatchObject({ enabled: false });
    await expect(store.claimDue("2026-07-30T05:30:00.000Z")).resolves.toEqual([]);
    await expect(service.saveDailySchedule("owner-a", { processId: "day_focus", timeOfDay: "08:30" })).resolves.toMatchObject({ id: saved.id, enabled: true });
    await expect(store.claimDue("2026-07-30T05:30:00.000Z")).resolves.toMatchObject([{ userId: "owner-a", processId: "day_focus" }]);
  });

  it("creates multiple reminders, weekday schedules, and nearest-future one-shots", async () => {
    const { timezones, service } = setup();
    timezones.set("owner-a", "Europe/Moscow");

    const daily = await service.saveDailySchedule("owner-a", { kind: "reminder", reminderText: "Выпить воды", timeOfDay: "09:00" });
    const weekday = await service.saveDailySchedule("owner-a", { kind: "reminder", reminderText: "Зарядка", timeOfDay: "07:30", daysOfWeek: 31 });
    const oneShot = await service.saveDailySchedule("owner-a", { kind: "reminder", reminderText: "Зум", timeOfDay: "15:00", oneShot: true });

    expect(daily).toMatchObject({ id: "schedule_1", kind: "reminder", reminderText: "Выпить воды", daysOfWeek: 127, oneShot: false });
    expect(weekday).toMatchObject({ id: "schedule_2", daysOfWeek: 31, nextFireAt: "2026-07-31T04:30:00.000Z" });
    expect(oneShot).toMatchObject({ id: "schedule_3", oneShot: true, nextFireAt: "2026-07-30T12:00:00.000Z" });
    await expect(service.listSchedules("owner-a")).resolves.toHaveLength(3);
    await expect(service.saveDailySchedule("owner-a", { kind: "reminder", reminderText: "x".repeat(513), timeOfDay: "10:00" })).rejects.toThrow("at most 512");
  });

  it("rejects a diagnostic process that is never scheduled at the boundary, not when the timer fires", async () => {
    const { service } = setup();

    // consent_and_privacy emits diagnostic evidence inside a conversation and has
    // no scheduled prompt; accepting it here would fail only once the timer fired.
    await expect(service.saveDailySchedule("owner-a", { processId: "consent_and_privacy" as never, timeOfDay: "09:00" }))
      .rejects.toThrow(/consent_and_privacy/u);
  });

  it("updates an exact owner reminder without duplicating it and rejects unsafe targets", async () => {
    const { store, timezones, service } = setup();
    timezones.set("owner-a", "Europe/Moscow");
    timezones.set("owner-b", "Asia/Tokyo");

    const reminder = await service.saveDailySchedule("owner-a", { kind: "reminder", reminderText: "Выпить воды", timeOfDay: "09:00" });
    const updated = await service.saveDailySchedule("owner-a", {
      scheduleId: reminder.id, kind: "reminder", reminderText: "Выпить воды", timeOfDay: "10:00",
    });
    expect(updated).toMatchObject({ id: reminder.id, kind: "reminder", timeOfDay: "10:00", enabled: true });
    await expect(service.listSchedules("owner-a")).resolves.toHaveLength(1);

    const foreign = await service.saveDailySchedule("owner-b", { kind: "reminder", reminderText: "Чужое", timeOfDay: "11:00" });
    await expect(service.saveDailySchedule("owner-a", {
      scheduleId: foreign.id, kind: "reminder", reminderText: "Утечка", timeOfDay: "12:00",
    })).rejects.toBeInstanceOf(AssistantScheduleNotFoundError);
    await expect(store.get("owner-b", foreign.id)).resolves.toMatchObject({ reminderText: "Чужое", timeOfDay: "11:00" });

    const process = await service.saveDailySchedule("owner-a", { processId: "day_focus", timeOfDay: "08:30" });
    await expect(service.saveDailySchedule("owner-a", {
      scheduleId: process.id, kind: "reminder", reminderText: "Не процесс", timeOfDay: "08:30",
    })).rejects.toBeInstanceOf(AssistantScheduleKindChangeError);

    const secondReminder = await service.saveDailySchedule("owner-a", { kind: "reminder", reminderText: "Второе", timeOfDay: "13:00" });
    expect(secondReminder.id).not.toBe(reminder.id);
    await expect(service.disableSchedule("owner-a", process.id)).resolves.toMatchObject({ enabled: false });
    await expect(service.saveDailySchedule("owner-a", { processId: "day_focus", timeOfDay: "08:45" })).resolves.toMatchObject({ id: process.id, enabled: true });
  });

  it("keeps all three tool outputs schema-valid and owner-free", async () => {
    const { timezones, service } = setup();
    timezones.set("owner-a", "Europe/Moscow");
    const capabilities = {
      listSchedules: () => service.listSchedules("owner-a"),
      saveDailySchedule: (input: Parameters<typeof service.saveDailySchedule>[1]) => service.saveDailySchedule("owner-a", input),
      disableSchedule: (scheduleId: string) => service.disableSchedule("owner-a", scheduleId),
    };
    const tools = createScheduleTools(capabilities);

    const unsupported = await tools.setDailySchedule.execute?.({ processId: "invented", timeOfDay: "08:30" }, {} as never);
    expect(unsupported).toMatchObject({ status: "unsupported_process" });
    expect(() => scheduleMutationOutputSchema.parse(unsupported)).not.toThrow();

    const saved = await tools.setDailySchedule.execute?.({ processId: "day_focus", timeOfDay: "08:30", daysOfWeek: 31 }, {} as never);
    expect(() => scheduleMutationOutputSchema.parse(saved)).not.toThrow();
    const reminder = await tools.setDailySchedule.execute?.({ kind: "reminder", reminderText: "<b>вода</b> 💧", timeOfDay: "15:00", oneShot: true }, {} as never);
    expect(() => scheduleMutationOutputSchema.parse(reminder)).not.toThrow();
    const reminderId = (reminder as { status: "saved"; schedule: { id: string } }).schedule.id;
    const changed = await tools.setDailySchedule.execute?.({ scheduleId: reminderId, kind: "reminder", reminderText: "<b>вода</b> 💧", timeOfDay: "16:00" }, {} as never);
    expect(changed).toMatchObject({ status: "saved", schedule: { id: reminderId, timeOfDay: "16:00" } });
    const missing = await tools.setDailySchedule.execute?.({ scheduleId: "missing", kind: "reminder", reminderText: "Вода", timeOfDay: "17:00" }, {} as never);
    expect(missing).toEqual({ status: "not_found" });
    expect(() => scheduleMutationOutputSchema.parse(missing)).not.toThrow();
    const wrongKind = await tools.setDailySchedule.execute?.({ scheduleId: (saved as { status: "saved"; schedule: { id: string } }).schedule.id, kind: "reminder", reminderText: "Вода", timeOfDay: "17:00" }, {} as never);
    expect(wrongKind).toMatchObject({ status: "unsupported_process" });
    expect(() => scheduleMutationOutputSchema.parse(wrongKind)).not.toThrow();
    const listed = await tools.listSchedules.execute?.({}, {} as never);
    expect(() => scheduleListOutputSchema.parse(listed)).not.toThrow();
    const schedule = scheduleViewSchema.parse((listed as { schedules: unknown[] }).schedules[0]);
    expect((listed as { schedules: Array<{ kind: string; reminderText?: string }> }).schedules).toContainEqual(expect.objectContaining({ kind: "reminder", reminderText: "<b>вода</b> 💧" }));
    const disabled = await tools.disableSchedule.execute?.({ scheduleId: schedule.id }, {} as never);
    expect(() => scheduleMutationOutputSchema.parse(disabled)).not.toThrow();

    const visible = JSON.stringify({ saved, listed, disabled });
    expect(visible).not.toMatch(/userId|createdAt|updatedAt/);
  });
});
