import { assistantDiagnosticProcessIds } from "../domain/assistant-process.js";
import type { ProcessSchedule } from "../domain/schedule.js";
import type { ScheduleView } from "../contracts/minutka-api.js";

/** Explicit model/transport projection; private owner and persistence fields stay internal. */
export function toScheduleView(schedule: ProcessSchedule): ScheduleView {
  if (schedule.kind === "process" && (!schedule.processId || !(assistantDiagnosticProcessIds as readonly string[]).includes(schedule.processId))) {
    throw new Error(`Unsupported assistant schedule process: ${schedule.processId ?? schedule.kind}`);
  }
  if (schedule.kind === "reminder" && !schedule.reminderText) throw new Error("Reminder schedule text is required");
  return {
    id: schedule.id,
    kind: schedule.kind,
    ...(schedule.processId === undefined ? {} : { processId: schedule.processId as ScheduleView["processId"] }),
    ...(schedule.reminderText === undefined ? {} : { reminderText: schedule.reminderText }),
    daysOfWeek: schedule.daysOfWeek,
    oneShot: schedule.oneShot,
    timeOfDay: schedule.timeOfDay,
    timezone: schedule.timezone,
    enabled: schedule.enabled,
    nextFireAt: schedule.nextFireAt,
  };
}
