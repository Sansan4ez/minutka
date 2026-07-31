import { describe, expect, it } from "vitest";
import { createInMemoryScheduleStore } from "../../../src/application/in-memory-schedule-store.js";
import { ScheduleManagementService } from "../../../src/application/schedule-management-service.js";
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
        employeeId, preferredName: employeeId, assistantName: "Ассистент", addressForm: "informal" as const,
        persona: "efficiency" as const, responseLength: "balanced" as const, timezone, createdAt: now, updatedAt: now,
      } : undefined;
    },
  };
  return { store, timezones, service: new ScheduleManagementService(store, profiles, clock) };
}

describe("SPEC-PERSONAL-ASSISTANT-SCHEDULE-TOOLS-001: owner schedule use-cases and tools", () => {
  it("keeps list, save, and disable owner-scoped and recalculates in the profile timezone", async () => {
    const { store, timezones, service } = setup();
    timezones.set("owner-a", "Europe/Moscow");
    timezones.set("owner-b", "Asia/Tokyo");

    const saved = await service.saveDailySchedule("owner-a", { processId: "day_focus", timeOfDay: "08:30" });
    expect(saved).toMatchObject({
      id: "owner-a:day_focus-daily", userId: "owner-a", processId: "day_focus",
      timeOfDay: "08:30", timezone: "Europe/Moscow", enabled: true,
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

  it("keeps all three tool outputs schema-valid and owner-free", async () => {
    const { timezones, service } = setup();
    timezones.set("owner-a", "Europe/Moscow");
    const capabilities = {
      listSchedules: () => service.listSchedules("owner-a"),
      saveDailySchedule: (input: { processId: string; timeOfDay: string; timezone?: string }) => service.saveDailySchedule("owner-a", input),
      disableSchedule: (scheduleId: string) => service.disableSchedule("owner-a", scheduleId),
    };
    const tools = createScheduleTools(capabilities);

    const unsupported = await tools.setDailySchedule.execute?.({ processId: "invented", timeOfDay: "08:30" }, {} as never);
    expect(unsupported).toMatchObject({ status: "unsupported_process" });
    expect(() => scheduleMutationOutputSchema.parse(unsupported)).not.toThrow();

    const saved = await tools.setDailySchedule.execute?.({ processId: "day_focus", timeOfDay: "08:30" }, {} as never);
    expect(() => scheduleMutationOutputSchema.parse(saved)).not.toThrow();
    const listed = await tools.listSchedules.execute?.({}, {} as never);
    expect(() => scheduleListOutputSchema.parse(listed)).not.toThrow();
    const schedule = scheduleViewSchema.parse((listed as { schedules: unknown[] }).schedules[0]);
    const disabled = await tools.disableSchedule.execute?.({ scheduleId: schedule.id }, {} as never);
    expect(() => scheduleMutationOutputSchema.parse(disabled)).not.toThrow();

    const visible = JSON.stringify({ saved, listed, disabled });
    expect(visible).not.toMatch(/userId|createdAt|updatedAt/);
  });
});
