import type { ProcessSchedule, ScheduleFire } from "../domain/schedule.js";
import { nextDailyFireAt, normalizeDailyTime } from "../shared/schedule-time.js";
import { normalizeIanaTimezone } from "../shared/iana-timezone.js";
import type { Clock } from "./runtime-primitives.js";
import type { ScheduleStore } from "./schedule-store.js";

export class SchedulerService {
  private tickInFlight: Promise<ScheduleFire[]> | undefined;

  constructor(
    private readonly store: ScheduleStore,
    private readonly clock: Clock,
  ) {}

  async saveDailySchedule(userId: string, input: {
    id: string;
    processId: string;
    timeOfDay: string;
    timezone: string;
    enabled?: boolean;
  }): Promise<ProcessSchedule> {
    const timezone = normalizeIanaTimezone(input.timezone);
    if (!timezone) throw new Error("timezone must be a valid IANA timezone");
    const timeOfDay = normalizeDailyTime(input.timeOfDay);
    return this.store.save(userId, {
      id: input.id,
      processId: input.processId,
      timeOfDay,
      timezone,
      enabled: input.enabled ?? true,
      nextFireAt: nextDailyFireAt({ after: this.clock.now(), timeOfDay, timezone }),
    });
  }

  /** Coalesces overlapping interval callbacks inside the single pilot instance. */
  tick(): Promise<ScheduleFire[]> {
    if (this.tickInFlight) return this.tickInFlight;
    const current = this.store.claimDue(this.clock.now());
    this.tickInFlight = current;
    void current.finally(() => {
      if (this.tickInFlight === current) this.tickInFlight = undefined;
    }).catch(() => undefined);
    return current;
  }
}
