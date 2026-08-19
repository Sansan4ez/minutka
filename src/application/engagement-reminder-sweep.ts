import { localHourInIanaTimezone } from "../shared/schedule-time.js";
import { participantEngagement } from "./participant-engagement.js";
import { systemClock, type Clock } from "./runtime-primitives.js";

/**
 * Participation state the automatic reminder needs. It carries the touch date,
 * the profile timezone and the reminder counters only: conversation content,
 * activities, traces and insights are never inputs of this decision.
 */
export type EngagementReminderCandidate = {
  employeeId: string;
  timezone: string;
  lastTouchOn?: string;
  engagementRemindersSent: number;
  lastEngagementReminderAt?: string;
};

/** Participation-reminder slice of the profile store; no other store is read. */
export type EngagementReminderStore = {
  /**
   * Every onboarded participant with a started engagement clock. The sweep is a
   * system job over all tenants, so it projects no company, group, subject key
   * or transport identity — only what the reminder decision consumes.
   */
  listEngagementReminderCandidates(): Promise<EngagementReminderCandidate[]>;
  /** Records one automatic reminder against the per-participant limits. */
  recordEngagementReminderSent(input: { employeeId: string; sentAt: string }): Promise<void>;
};

export type EngagementReminderDecision =
  | "send"
  | "not_lagging"
  | "outside_local_window"
  | "reminded_recently"
  | "reminder_limit_reached";

/**
 * Local wall-clock window of the automatic reminder. A sweep tick outside it
 * sends nothing, so a participant is never woken up by the bot at night; the
 * window is wide enough for the reminder to survive a restart during the day.
 */
export const engagementReminderLocalWindow = { fromHour: 13, toHour: 21 } as const;
/**
 * Automatic reminders one participant may receive over the pilot cycle. After
 * them the bot stays silent and the live tiers (methodologist, then company
 * lead) take over. Pilot constants; the first week calibrates them.
 */
export const maximumAutomaticEngagementReminders = 2;
const millisecondsPerDay = 24 * 60 * 60 * 1_000;

/**
 * Decides a single reminder without any side effect. Only the `lagging` label
 * is reminded: `active` needs nothing, and `dropped_off` is already the
 * methodologist's tier, not the bot's.
 */
export function engagementReminderDecision(
  candidate: EngagementReminderCandidate,
  now: string,
): EngagementReminderDecision {
  if (participantEngagement({ ...candidate, now }) !== "lagging") return "not_lagging";
  if (candidate.engagementRemindersSent >= maximumAutomaticEngagementReminders) return "reminder_limit_reached";
  if (candidate.lastEngagementReminderAt !== undefined
    && new Date(now).valueOf() - new Date(candidate.lastEngagementReminderAt).valueOf() < millisecondsPerDay) {
    return "reminded_recently";
  }
  const localHour = localHourInIanaTimezone(now, candidate.timezone);
  if (localHour < engagementReminderLocalWindow.fromHour || localHour >= engagementReminderLocalWindow.toHour) {
    return "outside_local_window";
  }
  return "send";
}

/** Outbound port; a participant without a delivery session is skipped, not failed. */
export type EngagementReminderDelivery = (input: {
  employeeId: string;
  text: string;
}) => Promise<"delivered" | "delivery_session_missing">;
export type EngagementReminderSweepResult = { considered: number; sent: number; failed: number };
export type EngagementReminderLogger = (entry: { errorCode: string; error: unknown }) => void;

/**
 * Daily system check over the participation set: a lagging participant receives
 * one predefined message without an operator in the loop. The sweep never opens
 * a conversation turn and never records a touch, so the reminder itself cannot
 * move the participation label it reads.
 */
export class EngagementReminderSweep {
  private text: string | undefined;

  constructor(
    private readonly store: EngagementReminderStore,
    private readonly deliver: EngagementReminderDelivery,
    private readonly readText: () => string,
    private readonly clock: Clock = systemClock,
    private readonly logger: EngagementReminderLogger = logReminderFailure,
  ) {}

  async run(): Promise<EngagementReminderSweepResult> {
    const candidates = await this.store.listEngagementReminderCandidates();
    const result: EngagementReminderSweepResult = { considered: candidates.length, sent: 0, failed: 0 };
    for (const candidate of candidates) {
      const now = this.clock.now();
      try {
        if (engagementReminderDecision(candidate, now) !== "send") continue;
        this.text ??= this.readText();
        if (await this.deliver({ employeeId: candidate.employeeId, text: this.text }) !== "delivered") continue;
        // Recorded after a confirmed delivery: an undelivered reminder must not
        // consume one of the few automatic attempts a participant ever gets.
        await this.store.recordEngagementReminderSent({ employeeId: candidate.employeeId, sentAt: now });
        result.sent += 1;
      } catch (error) {
        // One unreachable participant must not stop the sweep for the others.
        result.failed += 1;
        try { this.logger({ errorCode: reminderErrorCode(error), error }); }
        catch { /* logging must not stop the sweep */ }
      }
    }
    return result;
  }
}

function reminderErrorCode(error: unknown): string {
  const raw = error instanceof Error && error.name.trim() ? error.name : "UnknownError";
  return raw.replace(/[^A-Za-z0-9_.-]/gu, "_").slice(0, 120) || "UnknownError";
}

function logReminderFailure(entry: { errorCode: string }): void {
  console.warn(`Automatic engagement reminder failed (${entry.errorCode}).`);
}
