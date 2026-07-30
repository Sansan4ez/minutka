import type { ProcessSchedule, ScheduleFire } from "../domain/schedule.js";

export type SaveProcessScheduleInput = Pick<
  ProcessSchedule,
  "id" | "processId" | "timeOfDay" | "timezone" | "enabled" | "nextFireAt"
>;

export type CompleteScheduleFireInput = {
  scheduleId: string;
  scheduledFor: string;
  status: "succeeded" | "failed";
  errorCode?: string;
};

/** Durable scheduler boundary. All public record reads and writes are owner-scoped. */
export interface ScheduleStore {
  save(userId: string, input: SaveProcessScheduleInput): Promise<ProcessSchedule>;
  get(userId: string, scheduleId: string): Promise<ProcessSchedule | null>;
  /** Materializes due occurrences and returns pending work for startup recovery. */
  claimDue(now: string, limit?: number): Promise<ScheduleFire[]>;
  listFires(userId: string, scheduleId?: string): Promise<ScheduleFire[]>;
  completeFire(userId: string, input: CompleteScheduleFireInput): Promise<ScheduleFire | null>;
}
