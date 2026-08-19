import type { ParticipantPageCursor } from "./participant-pagination.js";
import type { ProfileStore } from "./profile-store.js";
import type { SaveDailyScheduleInput } from "./schedule-management-service.js";
import { normalizeDailyTime } from "../shared/schedule-time.js";
import type { ProcessSchedule } from "../domain/schedule.js";

/** Every weekday plus the weekend: the cycle ends on the day the operator names, not on a weekday mask. */
const everyDayMask = 127;
const participantPageSize = 100;

export type FinalReportScope = { companyId: string; groupId: string };
export type FinalReportArmingInput = FinalReportScope & { timeOfDay: string };

export type FinalReportArmingPreview = {
  companyId: string;
  groupId: string;
  timeOfDay: string;
  /** Participants that completed onboarding and therefore receive the report. */
  eligible: number;
  /** Participants of the same group that are still onboarding and are left out. */
  notOnboarded: number;
  /** The exact line the operator must type before the group receives anything. */
  confirmation: string;
};

export type FinalReportArmingOutcome = {
  employeeId: string;
  status: "armed" | "failed";
  errorCode?: string;
};

export type FinalReportArmingResult = {
  companyId: string;
  groupId: string;
  timeOfDay: string;
  armed: number;
  failed: number;
  outcomes: FinalReportArmingOutcome[];
};

export function finalReportArmingConfirmation(scope: FinalReportScope): string {
  return `SEND FINAL REPORT ${scope.companyId}/${scope.groupId}`;
}

/**
 * Operator-scoped end of the two-week cycle for one training group.
 *
 * It arms one non-recurring `final_report` touch per onboarded participant at
 * the named local time and delivers nothing itself: the existing scheduler and
 * its idempotency ledger fire the touch through the employee's own Telegram
 * session, so a rerun re-arms the same row instead of sending twice. Content of
 * the report stays inside the employee's personal contour; this command knows
 * only the participation set of the group.
 */
export class FinalReportArmingService {
  constructor(
    private readonly participants: Pick<ProfileStore, "listParticipants">,
    private readonly schedules: { saveDailySchedule(userId: string, input: SaveDailyScheduleInput): Promise<ProcessSchedule> },
  ) {}

  async preview(input: FinalReportArmingInput): Promise<FinalReportArmingPreview> {
    const scope = parseScope(input);
    const timeOfDay = normalizeDailyTime(input.timeOfDay);
    const { eligible, notOnboarded } = await this.readGroup(scope);
    return {
      ...scope,
      timeOfDay,
      eligible: eligible.length,
      notOnboarded,
      confirmation: finalReportArmingConfirmation(scope),
    };
  }

  async arm(input: FinalReportArmingInput): Promise<FinalReportArmingResult> {
    const scope = parseScope(input);
    const timeOfDay = normalizeDailyTime(input.timeOfDay);
    const { eligible } = await this.readGroup(scope);
    const outcomes: FinalReportArmingOutcome[] = [];
    for (const employeeId of eligible) {
      try {
        await this.schedules.saveDailySchedule(employeeId, {
          processId: "final_report",
          timeOfDay,
          daysOfWeek: everyDayMask,
          oneShot: true,
        });
        outcomes.push({ employeeId, status: "armed" });
      } catch (error) {
        // A single unreachable participant must not hide the rest of the group.
        outcomes.push({ employeeId, status: "failed", errorCode: safeErrorCode(error) });
      }
    }
    return {
      ...scope,
      timeOfDay,
      armed: outcomes.filter(({ status }) => status === "armed").length,
      failed: outcomes.filter(({ status }) => status === "failed").length,
      outcomes,
    };
  }

  /** Closed participation set of one training group; company isolation is part of the query. */
  private async readGroup(scope: FinalReportScope): Promise<{ eligible: string[]; notOnboarded: number }> {
    const eligible: string[] = [];
    let notOnboarded = 0;
    let after: ParticipantPageCursor | undefined;
    for (;;) {
      const page = await this.participants.listParticipants({
        ...scope,
        limit: participantPageSize,
        ...(after ? { after } : {}),
      });
      for (const participant of page) {
        if (participant.companyId !== scope.companyId || participant.groupId !== scope.groupId) continue;
        if (participant.status === "profile_completed") eligible.push(participant.employeeId);
        else notOnboarded += 1;
      }
      const last = page.at(-1);
      if (page.length < participantPageSize || !last) break;
      after = { createdAt: last.createdAt, employeeId: last.employeeId };
    }
    return { eligible, notOnboarded };
  }
}

function parseScope(input: FinalReportScope): FinalReportScope {
  const companyId = input.companyId.trim();
  const groupId = input.groupId.trim();
  if (!companyId) throw new Error("companyId is required");
  if (!groupId) throw new Error("groupId is required");
  return { companyId, groupId };
}

/** Class name only: an arming outcome never carries a provider payload or personal text. */
function safeErrorCode(error: unknown): string {
  return error instanceof Error && error.name ? error.name : "Error";
}
