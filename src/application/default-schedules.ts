import type { AssistantScheduledProcessId } from "../domain/assistant-process.js";
import type { ProcessSchedule } from "../domain/schedule.js";
import { normalizeIanaTimezone } from "../shared/iana-timezone.js";
import { nextDailyFireAt } from "../shared/schedule-time.js";
import { defaultScheduleId } from "./schedule-management-service.js";
import type { Clock } from "./runtime-primitives.js";
import type { ScheduleStore } from "./schedule-store.js";

/**
 * Two daily touches on weekdays (`31`) plus the Friday personal checkpoint
 * (`16`). The weekly time stays inside the working day so the employee can
 * still answer it; the first pilot week calibrates the day and the time.
 */
export const defaultSchedules = [
  { processId: "morning_planning", timeOfDay: "08:30", daysOfWeek: 31 },
  { processId: "evening_reflection", timeOfDay: "19:00", daysOfWeek: 31 },
  { processId: "weekly_summary", timeOfDay: "17:00", daysOfWeek: 16 },
] as const satisfies readonly { processId: AssistantScheduledProcessId; timeOfDay: string; daysOfWeek: number }[];

export type DefaultScheduleProvisionResult = {
  created: boolean;
  schedules: ProcessSchedule[];
};

/**
 * Creates each default schedule once. Existing personal settings always win,
 * and a switched-off touch keeps its disabled row, so provisioning never
 * revives it — only a touch the employee has never had is added.
 */
export class DefaultScheduleProvisioner {
  constructor(
    private readonly store: ScheduleStore,
    private readonly clock: Clock,
  ) {}

  async provision(userId: string, timezoneInput: string): Promise<DefaultScheduleProvisionResult> {
    const existing = await this.store.list(userId);
    const missing = defaultSchedules.filter((schedule) =>
      !existing.some((candidate) => candidate.kind === "process" && candidate.processId === schedule.processId));
    if (missing.length === 0) return { created: false, schedules: existing };

    const timezone = normalizeIanaTimezone(timezoneInput);
    if (!timezone) throw new Error("completed profile timezone must be a valid IANA timezone");
    const after = this.clock.now();
    const schedules = [...existing];
    for (const schedule of missing) {
      schedules.push(await this.store.save(userId, {
        id: defaultScheduleId(userId, schedule.processId),
        processId: schedule.processId,
        timeOfDay: schedule.timeOfDay,
        daysOfWeek: schedule.daysOfWeek,
        timezone,
        enabled: true,
        nextFireAt: nextDailyFireAt({
          after,
          timeOfDay: schedule.timeOfDay,
          timezone,
          daysOfWeek: schedule.daysOfWeek,
        }),
      }));
    }
    return { created: true, schedules };
  }
}
