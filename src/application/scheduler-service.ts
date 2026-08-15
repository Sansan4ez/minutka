import type { ProcessSchedule, ScheduleFire } from "../domain/schedule.js";
import { isAssistantScheduledProcessId, type AssistantScheduledProcessId } from "../domain/assistant-process.js";
import { nextDailyFireAt, normalizeDailyTime } from "../shared/schedule-time.js";
import { normalizeIanaTimezone } from "../shared/iana-timezone.js";
import type { Clock } from "./runtime-primitives.js";
import type { ScheduleStore } from "./schedule-store.js";

type ScheduledFireContext = Omit<ScheduleFire, "kind" | "processId" | "reminderText">;
export type ScheduledActionFire = ScheduledFireContext & (
  | { kind: "process"; processId: AssistantScheduledProcessId }
  | { kind: "reminder"; text: string }
);
export type ScheduledProcessRunner = (fire: ScheduledActionFire) => Promise<void>;
export type SchedulerOperationalLogger = (entry: { fire: ScheduleFire; errorCode: string; error: unknown }) => void;

export class SchedulerService {
  private tickInFlight: Promise<ScheduleFire[]> | undefined;

  constructor(
    private readonly store: ScheduleStore,
    private readonly clock: Clock,
    private readonly runScheduledProcess?: ScheduledProcessRunner,
    private readonly operationalLogger: SchedulerOperationalLogger = logSchedulerFailure,
  ) {}

  async saveDailySchedule(userId: string, input: {
    id: string;
    processId: string;
    timeOfDay: string;
    timezone: string;
    daysOfWeek?: number;
    enabled?: boolean;
  }): Promise<ProcessSchedule> {
    const timezone = normalizeIanaTimezone(input.timezone);
    if (!timezone) throw new Error("timezone must be a valid IANA timezone");
    const timeOfDay = normalizeDailyTime(input.timeOfDay);
    return this.store.save(userId, {
      id: input.id,
      processId: input.processId,
      daysOfWeek: input.daysOfWeek,
      timeOfDay,
      timezone,
      enabled: input.enabled ?? true,
      nextFireAt: nextDailyFireAt({ after: this.clock.now(), timeOfDay, timezone, daysOfWeek: input.daysOfWeek }),
    });
  }

  /** Coalesces overlapping interval callbacks inside the single pilot instance. */
  tick(): Promise<ScheduleFire[]> {
    if (this.tickInFlight) return this.tickInFlight;
    const current = this.runTick();
    this.tickInFlight = current;
    void current.finally(() => {
      if (this.tickInFlight === current) this.tickInFlight = undefined;
    }).catch(() => undefined);
    return current;
  }

  private async runTick(): Promise<ScheduleFire[]> {
    const fires = await this.store.claimDue(this.clock.now());
    const runner = this.runScheduledProcess;
    if (!runner) return fires;
    for (const fire of fires) await this.runFire(fire, runner);
    return fires;
  }

  private async runFire(fire: ScheduleFire, runner: ScheduledProcessRunner): Promise<void> {
    try {
      const { processId: _processId, reminderText: _reminderText, ...context } = fire;
      if (fire.kind === "reminder") {
        if (!fire.reminderText) throw new UnsupportedScheduledProcessError();
        await runner({ ...context, kind: "reminder", text: fire.reminderText });
      } else {
        if (!fire.processId || !isAssistantScheduledProcessId(fire.processId)) throw new UnsupportedScheduledProcessError();
        await runner({ ...context, kind: "process", processId: fire.processId });
      }
      if (fire.oneShot) await this.disableSchedule(fire);
      await this.store.completeFire(fire.userId, {
        scheduleId: fire.scheduleId,
        scheduledFor: fire.scheduledFor,
        status: "succeeded",
      });
    } catch (error) {
      const errorCode = scheduleErrorCode(error);
      try {
        await this.store.completeFire(fire.userId, {
          scheduleId: fire.scheduleId,
          scheduledFor: fire.scheduledFor,
          status: "failed",
          errorCode,
        });
      } catch (completionError) {
        try { this.operationalLogger({ fire, errorCode: scheduleErrorCode(completionError), error: completionError }); }
        catch { /* logging must not replace the tick failure */ }
        throw completionError;
      }
      try { this.operationalLogger({ fire, errorCode, error }); }
      catch { /* logging must not stop the scheduler tick */ }
    }
  }

  private async disableSchedule(fire: ScheduleFire): Promise<void> {
    const schedule = await this.store.get(fire.userId, fire.scheduleId);
    if (!schedule?.enabled) return;
    await this.store.save(fire.userId, {
      id: schedule.id,
      daysOfWeek: schedule.daysOfWeek,
      kind: schedule.kind,
      ...(schedule.processId === undefined ? {} : { processId: schedule.processId }),
      ...(schedule.reminderText === undefined ? {} : { reminderText: schedule.reminderText }),
      oneShot: schedule.oneShot,
      timeOfDay: schedule.timeOfDay,
      timezone: schedule.timezone,
      enabled: false,
      nextFireAt: schedule.nextFireAt,
    });
  }
}

class UnsupportedScheduledProcessError extends Error {
  constructor() { super("Scheduled process is not supported."); this.name = "UnsupportedScheduledProcessError"; }
}

function scheduleErrorCode(error: unknown): string {
  const raw = error instanceof Error && error.name.trim() ? error.name : "UnknownError";
  return raw.replace(/[^A-Za-z0-9_.-]/gu, "_").slice(0, 120) || "UnknownError";
}

function logSchedulerFailure(entry: { fire: ScheduleFire; errorCode: string }): void {
  console.warn(`Scheduled action failed (${entry.errorCode}; schedule=${entry.fire.scheduleId}; kind=${entry.fire.kind}).`);
}
