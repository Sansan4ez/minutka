import type { AuditEventStore } from "../audit-event-store.js";
import type { UserProfile } from "../../domain/employee.js";
import type { Clock } from "../runtime-primitives.js";
import type { ConversationStore, ConversationTurn } from "../conversation-store.js";
import type { FeedbackStore } from "../feedback-store.js";
import type { InsightStore } from "../insight-store.js";
import type { ProfileStore } from "../profile-store.js";
import { runtimeProjectionLimits } from "./runtime-projection-limits.js";
import type { RuntimeAccessScope } from "./runtime-access-scope.js";
import type {
  AllowedRuntimePath,
  DecisionProjection,
  ProcSnapshot,
  RunSnapshot,
  RuntimeProjection,
  ProfileProjection,
} from "./runtime-projection-types.js";

export type RuntimeProjectionBuilder = {
  buildProc(scope: RuntimeAccessScope): Promise<ProcSnapshot>;
  /** Chat-specific read model avoids loading projections that the prompt does not render. */
  buildChatProc(scope: RuntimeAccessScope): Promise<{ snapshot: ProcSnapshot; profile?: UserProfile }>;
  buildDecision(
    scope: RuntimeAccessScope,
    decision: DecisionProjection,
  ): RuntimeProjection<DecisionProjection>;
  buildRun(scope: RuntimeAccessScope): Promise<RunSnapshot>;
};

export function createRuntimeProjectionBuilder(deps: {
  profileStore: ProfileStore;
  conversationStore: ConversationStore;
  insightStore: InsightStore;
  feedbackStore: FeedbackStore;
  auditEventStore: AuditEventStore;
  clock: Clock;
}): RuntimeProjectionBuilder {
  const envelope = <T>(
    path: AllowedRuntimePath,
    scope: RuntimeAccessScope,
    data: T,
  ): RuntimeProjection<T> => ({
    schemaVersion: 1,
    path,
    generatedAt: deps.clock.now(),
    scope: {
      employeeId: scope.employeeId,
      ...(scope.threadId ? { threadId: scope.threadId } : {}),
      requestId: scope.requestId,
      purpose: scope.purpose,
    },
    data,
  });

  const projectProfile = (profile: Awaited<ReturnType<ProfileStore["getProfile"]>>): ProfileProjection | null =>
    profile
      ? {
          preferredName: profile.preferredName ?? profile.role ?? profile.employeeId,
          assistantName: profile.assistantName ?? "Ассистент",
          addressForm: profile.addressForm ?? "informal",
          persona: profile.persona,
          responseLength: profile.responseLength,
          timezone: profile.timezone ?? "Etc/UTC",
          ...(profile.role ? { role: profile.role } : {}),
          ...(profile.typicalTasks ? { typicalTasks: [...profile.typicalTasks] } : {}),
          ...(profile.aiLevel ? { aiLevel: profile.aiLevel } : {}),
          ...(profile.preferredCheckinsPerDay
            ? { preferredCheckinsPerDay: profile.preferredCheckinsPerDay }
            : {}),
        }
      : null;
  const thread = async (scope: RuntimeAccessScope) => {
    if (!scope.threadId) return [];
    return boundTurns(await deps.conversationStore.getRecentTurns({
      employeeId: scope.employeeId,
      threadId: scope.threadId,
      limit: runtimeProjectionLimits.threadTurns,
    }));
  };

  return {
    async buildChatProc(scope) {
      const [profile, turns] = await Promise.all([
        deps.profileStore.getProfile(scope.employeeId),
        thread(scope),
      ]);
      const snapshot: ProcSnapshot = {
        profile: envelope("/proc/profile", scope, projectProfile(profile)),
        consent: envelope("/proc/consent", scope, { accepted: false }),
        thread: envelope("/proc/thread", scope, { turns }),
        insights: envelope("/proc/insights", scope, []),
        feedback: envelope("/proc/feedback", scope, []),
      };
      return { snapshot, ...(profile ? { profile } : {}) };
    },
    async buildProc(scope) {
      const threadId = scope.threadId;
      const [profile, participant, consent, turns, insights, feedback] = await Promise.all([
        deps.profileStore.getProfile(scope.employeeId),
        deps.profileStore.getParticipant(scope.employeeId),
        deps.profileStore.getConsent(scope.employeeId),
        thread(scope),
        threadId ? deps.insightStore.listInsights({ employeeId: scope.employeeId, threadId, limit: runtimeProjectionLimits.insights }) : [],
        threadId ? deps.feedbackStore.listFeedback({ employeeId: scope.employeeId, threadId, limit: runtimeProjectionLimits.feedback }) : [],
      ]);
      return {
        profile: envelope("/proc/profile", scope, projectProfile(profile)),
        consent: envelope("/proc/consent", scope, {
          status: participant?.status,
          accepted: Boolean(consent),
          ...(consent ? { privacyVersion: consent.privacyVersion, acceptedAt: consent.acceptedAt } : {}),
        }),
        thread: envelope("/proc/thread", scope, { turns }),
        insights: envelope("/proc/insights", scope, insights),
        feedback: envelope("/proc/feedback", scope, feedback),
      };
    },
    buildDecision(scope, decision) {
      return envelope("/proc/decision", scope, decision);
    },
    async buildRun(scope) {
      return {
        current: envelope(
          "/run/current",
          scope,
          await deps.auditEventStore.listCurrent({
            requestId: scope.requestId,
            limit: runtimeProjectionLimits.runCurrent,
          }),
        ),
        recent: envelope(
          "/run/recent",
          scope,
          await deps.auditEventStore.listRecent({
            employeeId: scope.employeeId,
            ...(scope.threadId ? { threadId: scope.threadId } : {}),
            limit: runtimeProjectionLimits.runRecent,
          }),
        ),
      };
    },
  };
}

function boundTurns(turns: ConversationTurn[]): ConversationTurn[] {
  const newestFirst = [...turns].reverse();
  let characters = 0;
  const retained: ConversationTurn[] = [];
  for (const turn of newestFirst) {
    const userText = sanitiseTurnText(turn.userText);
    const agentResponse = sanitiseTurnText(turn.agentResponse);
    const size = Array.from(userText).length + Array.from(agentResponse).length;
    // Turns are evaluated newest-to-oldest: on overflow, retain the contiguous
    // newest suffix instead of creating holes or dropping the latest context.
    if (characters + size > runtimeProjectionLimits.threadCharacters) break;
    retained.push({ ...turn, userText, agentResponse });
    characters += size;
  }
  return retained.reverse();
}

function sanitiseTurnText(text: string): string {
  const cleaned = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  return [...cleaned].slice(0, runtimeProjectionLimits.threadTurnTextCharacters).join("");
}
