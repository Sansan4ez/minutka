import { isAssistantDiagnosticProcessId, type AssistantDiagnosticProcessId } from "../domain/assistant-process.js";
import type { ProcessSchedule } from "../domain/schedule.js";
import { normalizeIanaTimezone } from "../shared/iana-timezone.js";
import { nextDailyFireAt, normalizeDailyTime } from "../shared/schedule-time.js";
import { assertUserId } from "./document-store.js";
import type { ProfileStore } from "./profile-store.js";
import type { Clock } from "./runtime-primitives.js";
import type { ScheduleStore } from "./schedule-store.js";

export type SaveDailyScheduleInput = {
  processId: string;
  timeOfDay: string;
  timezone?: string;
};

export type OwnerScheduleCapabilities = {
  listSchedules(): Promise<ProcessSchedule[]>;
  saveDailySchedule(input: SaveDailyScheduleInput): Promise<ProcessSchedule>;
  disableSchedule(scheduleId: string): Promise<ProcessSchedule | null>;
};

/** Typed owner-scoped schedule use-cases shared by chat tools and transports. */
export class ScheduleManagementService {
  constructor(
    private readonly store: Pick<ScheduleStore, "list" | "get" | "save">,
    private readonly profiles: Pick<ProfileStore, "getProfile">,
    private readonly clock: Clock,
  ) {}

  listSchedules(userId: string): Promise<ProcessSchedule[]> {
    return this.store.list(assertUserId(userId));
  }

  async saveDailySchedule(userId: string, input: SaveDailyScheduleInput): Promise<ProcessSchedule> {
    const safeUserId = assertUserId(userId);
    if (!isAssistantDiagnosticProcessId(input.processId)) {
      throw new UnsupportedAssistantScheduleProcessError(input.processId);
    }
    const profile = await this.profiles.getProfile(safeUserId);
    if (!profile) throw new Error("completed owner profile is required to manage schedules");
    const timezone = normalizeIanaTimezone(input.timezone ?? profile.timezone);
    if (!timezone) throw new Error("timezone must be a valid IANA timezone");
    const timeOfDay = normalizeDailyTime(input.timeOfDay);
    const existing = (await this.store.list(safeUserId)).find((schedule) => schedule.processId === input.processId);
    return this.store.save(safeUserId, {
      id: existing?.id ?? dailyScheduleId(safeUserId, input.processId),
      processId: input.processId,
      timeOfDay,
      timezone,
      enabled: true,
      nextFireAt: nextDailyFireAt({ after: this.clock.now(), timeOfDay, timezone }),
    });
  }

  async disableSchedule(userId: string, scheduleId: string): Promise<ProcessSchedule | null> {
    const safeUserId = assertUserId(userId);
    const existing = await this.store.get(safeUserId, scheduleId);
    if (!existing) return null;
    return this.store.save(safeUserId, {
      id: existing.id,
      processId: existing.processId,
      timeOfDay: existing.timeOfDay,
      timezone: existing.timezone,
      enabled: false,
      nextFireAt: existing.nextFireAt,
    });
  }
}

export class UnsupportedAssistantScheduleProcessError extends Error {
  constructor(readonly processId: string) {
    super(`Unsupported assistant schedule process: ${processId}`);
    this.name = "UnsupportedAssistantScheduleProcessError";
  }
}

function dailyScheduleId(userId: string, processId: AssistantDiagnosticProcessId): string {
  return `${userId}:${processId}-daily`;
}
