import { describe, expect, it } from "vitest";
import { createInMemoryScheduleStore } from "../../../src/application/in-memory-schedule-store.js";
import { createDeterministicIdGenerator } from "../../../src/application/runtime-primitives.js";
import {
  AssistantScheduleNotFoundError,
  ScheduleManagementService,
} from "../../../src/application/schedule-management-service.js";
import { createScheduleTools, scheduleListOutputSchema, scheduleMutationOutputSchema } from "../../../src/mastra/tools/schedule-tools.js";

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

describe("SPEC-PERSONAL-ASSISTANT-SCHEDULE-TOOLS-001: narrow owner schedule capabilities", () => {
  it("keeps the active morning and evening schedules owner-scoped", async () => {
    const { store, timezones, service } = setup();
    timezones.set("owner-a", "Europe/Moscow");
    timezones.set("owner-b", "Asia/Tokyo");

    const morning = await service.saveDailySchedule("owner-a", { processId: "morning_planning", timeOfDay: "08:30" });
    expect(morning).toMatchObject({
      id: "owner-a:morning_planning-daily", userId: "owner-a", kind: "process",
      processId: "morning_planning", timeOfDay: "08:30", timezone: "Europe/Moscow", enabled: true,
    });
    await service.saveDailySchedule("owner-b", { processId: "evening_reflection", timeOfDay: "20:00" });

    await expect(service.listSchedules("owner-a")).resolves.toMatchObject([{ processId: "morning_planning" }]);
    await expect(service.listSchedules("owner-b")).resolves.toMatchObject([{ processId: "evening_reflection" }]);
    await expect(service.disableSchedule("owner-b", morning.id)).resolves.toBeNull();
    await expect(store.get("owner-a", morning.id)).resolves.toMatchObject({ enabled: true });

    await expect(service.disableSchedule("owner-a", morning.id)).resolves.toMatchObject({ enabled: false });
    await expect(service.saveDailySchedule("owner-a", { processId: "morning_planning", timeOfDay: "08:45" }))
      .resolves.toMatchObject({ id: morning.id, enabled: true, timeOfDay: "08:45" });
  });

  it("refuses a schedule id from another process without changing either daily touch", async () => {
    const { timezones, service } = setup();
    timezones.set("owner-a", "Europe/Moscow");
    const morning = await service.saveDailySchedule("owner-a", {
      processId: "morning_planning", timeOfDay: "08:30", daysOfWeek: 31,
    });
    await service.saveDailySchedule("owner-a", {
      processId: "evening_reflection", timeOfDay: "19:00", daysOfWeek: 31,
    });
    const tools = createScheduleTools({
      listSchedules: () => service.listSchedules("owner-a"),
      saveDailySchedule: (input) => service.saveDailySchedule("owner-a", input),
      disableSchedule: (scheduleId) => service.disableSchedule("owner-a", scheduleId),
    });

    const refusal = await tools.setDailySchedule.execute?.({
      scheduleId: morning.id, processId: "evening_reflection", timeOfDay: "20:00",
    }, {} as never);
    expect(refusal).toEqual({
      status: "unsupported_process",
      message: "Выбранное расписание относится к другому сообщению. Используйте расписание для нужного утреннего или вечернего сообщения.",
    });
    expect(JSON.stringify(refusal)).not.toMatch(/processId|runtime|scheduleId/iu);
    await expect(service.listSchedules("owner-a")).resolves.toMatchObject([
      { id: morning.id, processId: "morning_planning", timeOfDay: "08:30", enabled: true },
      { processId: "evening_reflection", timeOfDay: "19:00", enabled: true },
    ]);
  });

  it("rejects day_focus and other non-active process ids at schedule management", async () => {
    const { timezones, service } = setup();
    timezones.set("owner-a", "Europe/Moscow");

    await expect(service.saveDailySchedule("owner-a", { processId: "day_focus", timeOfDay: "09:00" }))
      .rejects.toThrow("Unsupported assistant schedule process: day_focus");
    await expect(service.saveDailySchedule("owner-a", { processId: "consent_and_privacy", timeOfDay: "09:00" }))
      .rejects.toThrow("Unsupported assistant schedule process: consent_and_privacy");
  });

  it("exposes no arbitrary reminder fields and hides all legacy schedule rows", async () => {
    const { store, timezones, service } = setup();
    timezones.set("owner-a", "Europe/Moscow");
    await service.saveDailySchedule("owner-a", { processId: "morning_planning", timeOfDay: "08:30" });
    const legacyReminder = await service.saveDailySchedule("owner-a", {
      kind: "reminder", reminderText: "Выпить воды", timeOfDay: "15:00", oneShot: true,
    });
    await store.save("owner-a", {
      id: "owner-a:day_focus-daily", daysOfWeek: 127, kind: "process", processId: "day_focus", oneShot: false,
      timeOfDay: "09:00", timezone: "Europe/Moscow", enabled: true, nextFireAt: "2026-07-31T06:00:00.000Z",
    });

    const tools = createScheduleTools({
      listSchedules: () => service.listSchedules("owner-a"),
      saveDailySchedule: (input) => service.saveDailySchedule("owner-a", input),
      disableSchedule: (scheduleId) => service.disableSchedule("owner-a", scheduleId),
    });
    const inputSchema = tools.setDailySchedule.inputSchema!["~standard"].jsonSchema.input({ target: "draft-07" });
    expect(JSON.stringify(inputSchema)).not.toMatch(/reminder|reminderText|oneShot|kind/);

    await expect(service.listSchedules("owner-a")).resolves.toMatchObject([
      { kind: "process", processId: "morning_planning" },
    ]);
    const listed = await tools.listSchedules.execute?.({}, {} as never);
    expect(() => scheduleListOutputSchema.parse(listed)).not.toThrow();
    expect(listed).toMatchObject({ schedules: [{ kind: "process", processId: "morning_planning" }] });
    expect(JSON.stringify(listed)).not.toContain("Выпить воды");
    expect(JSON.stringify(listed)).not.toContain("day_focus");

    await expect(tools.disableSchedule.execute?.({ scheduleId: legacyReminder.id }, {} as never)).resolves.toEqual({ status: "not_found" });
    await expect(store.get("owner-a", legacyReminder.id)).resolves.toMatchObject({ enabled: true });
  });

  it("keeps tool outputs schema-valid, owner-free, and gives a plain refusal", async () => {
    const { timezones, service } = setup();
    timezones.set("owner-a", "Europe/Moscow");
    const tools = createScheduleTools({
      listSchedules: () => service.listSchedules("owner-a"),
      saveDailySchedule: (input) => service.saveDailySchedule("owner-a", input),
      disableSchedule: (scheduleId) => service.disableSchedule("owner-a", scheduleId),
    });

    const unsupported = await tools.setDailySchedule.execute?.({ processId: "day_focus" as never, timeOfDay: "08:30" }, {} as never);
    expect(unsupported).toMatchObject({ error: true });
    expect(JSON.stringify(unsupported)).toContain("morning_planning");
    expect(JSON.stringify(unsupported)).toContain("evening_reflection");

    const saved = await tools.setDailySchedule.execute?.({ processId: "evening_reflection", timeOfDay: "19:30", daysOfWeek: 31 }, {} as never);
    expect(() => scheduleMutationOutputSchema.parse(saved)).not.toThrow();
    const id = (saved as { status: "saved"; schedule: { id: string } }).schedule.id;
    const disabled = await tools.disableSchedule.execute?.({ scheduleId: id }, {} as never);
    expect(() => scheduleMutationOutputSchema.parse(disabled)).not.toThrow();
    expect(JSON.stringify({ saved, disabled })).not.toMatch(/userId|createdAt|updatedAt|reminderText/);

    await expect(tools.setDailySchedule.execute?.({ scheduleId: "missing", timeOfDay: "17:00" }, {} as never))
      .resolves.toEqual({ status: "not_found" });
    await expect(service.saveDailySchedule("owner-a", { scheduleId: "missing", processId: "evening_reflection", timeOfDay: "17:00" }))
      .rejects.toBeInstanceOf(AssistantScheduleNotFoundError);
  });
});
