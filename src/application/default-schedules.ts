import type { AssistantScheduledProcessId } from "../domain/assistant-process.js";
import type { ProcessSchedule } from "../domain/schedule.js";
import { normalizeIanaTimezone } from "../shared/iana-timezone.js";
import { nextDailyFireAt } from "../shared/schedule-time.js";
import type { Clock } from "./runtime-primitives.js";
import type { ScheduleStore } from "./schedule-store.js";

export const defaultDailySchedules = [
  { processId: "morning_activity_collection", timeOfDay: "08:30", daysOfWeek: 31 },
  { processId: "evening_reflection", timeOfDay: "19:00", daysOfWeek: 31 },
] as const satisfies readonly { processId: AssistantScheduledProcessId; timeOfDay: string; daysOfWeek: number }[];

export type DefaultScheduleProvisionResult = {
  created: boolean;
  schedules: ProcessSchedule[];
};

/** Creates the owner's initial schedules once; existing personal settings always win. */
export class DefaultScheduleProvisioner {
  constructor(
    private readonly store: ScheduleStore,
    private readonly clock: Clock,
  ) {}

  async provision(userId: string, timezoneInput: string): Promise<DefaultScheduleProvisionResult> {
    const existing = await this.store.list(userId);
    if (existing.length > 0) return { created: false, schedules: existing };

    const timezone = normalizeIanaTimezone(timezoneInput);
    if (!timezone) throw new Error("completed profile timezone must be a valid IANA timezone");
    const after = this.clock.now();
    const schedules: ProcessSchedule[] = [];
    for (const schedule of defaultDailySchedules) {
      schedules.push(await this.store.save(userId, {
        id: `${userId}:${schedule.processId}-daily`,
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
