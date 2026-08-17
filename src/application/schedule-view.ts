import { assistantScheduledProcessIds } from "../domain/assistant-process.js";
import type { ProcessSchedule } from "../domain/schedule.js";
import type { ScheduleView } from "../contracts/minutka-api.js";

/** Explicit model/transport projection; private owner and persistence fields stay internal. */
export function toScheduleView(schedule: ProcessSchedule): ScheduleView {
  if (schedule.kind !== "process" || !schedule.processId || !(assistantScheduledProcessIds as readonly string[]).includes(schedule.processId)) {
    throw new Error(`Unsupported assistant schedule process: ${schedule.processId ?? schedule.kind}`);
  }
  return {
    id: schedule.id,
    kind: "process",
    processId: schedule.processId as ScheduleView["processId"],
    daysOfWeek: schedule.daysOfWeek,
    oneShot: schedule.oneShot,
    timeOfDay: schedule.timeOfDay,
    timezone: schedule.timezone,
    enabled: schedule.enabled,
    nextFireAt: schedule.nextFireAt,
  };
}
