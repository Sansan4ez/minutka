import type { AuditEventStore } from "../audit-event-store.js";
import type { UserProfile } from "../../domain/employee.js";
import { currentPrivacyVersion } from "../../domain/privacy.js";
import type { ContextBudgetConfig } from "../context-budget.js";
import type { Clock } from "../runtime-primitives.js";
import type { ConversationStore, ConversationTurn } from "../conversation-store.js";
import type { ThreadSummaryStore } from "../thread-summary-store.js";
import type { FeedbackStore } from "../feedback-store.js";
import type { InsightStore } from "../insight-store.js";
import type { ProfileStore } from "../profile-store.js";
import { runtimeProjectionLimitsFromBudget, type RuntimeProjectionLimits } from "./runtime-projection-limits.js";
import type { RuntimeAccessScope } from "./runtime-access-scope.js";
import type {
  AllowedRuntimePath,
  ChatProcSnapshot,
  DecisionProjection,
  ProcSnapshot,
  RunSnapshot,
  RuntimeProjection,
  ProfileProjection,
} from "./runtime-projection-types.js";

export type RuntimeProjectionBuilder = {
  buildProc(scope: RuntimeAccessScope): Promise<ProcSnapshot>;
  /** Chat-specific read model avoids loading projections that the prompt does not render. */
  buildChatProc(scope: RuntimeAccessScope): Promise<{ snapshot: ChatProcSnapshot; profile?: UserProfile }>;
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
  contextBudget?: ContextBudgetConfig;
  threadSummaryStore?: ThreadSummaryStore;
}): RuntimeProjectionBuilder {
  const limits = runtimeProjectionLimitsFromBudget(deps.contextBudget);
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
          preferredName: profile.preferredName ?? profile.role ?? "Владелец",
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
    if (!scope.threadId) return { turns: [], truncated: false };
    const [source, storedSummary] = await Promise.all([
      deps.conversationStore.getRecentTurns({
        employeeId: scope.employeeId,
        threadId: scope.threadId,
        // Fetch one extra completed turn so the projection can report count
        // truncation without loading unbounded history.
        limit: limits.threadTurns + 1,
      }),
      deps.threadSummaryStore?.get({ employeeId: scope.employeeId, threadId: scope.threadId }),
    ]);
    const countTruncated = source.length > limits.threadTurns;
    const bounded = boundTurns(source.slice(-limits.threadTurns), limits);
    const summary = storedSummary && Array.from(storedSummary.text).length <= limits.threadSummaryCharacters
      ? storedSummary
      : undefined;
    return { ...(summary ? { summary } : {}), turns: bounded.turns, truncated: countTruncated || bounded.truncated };
  };

  return {
    async buildChatProc(scope) {
      const [profile, turns] = await Promise.all([
        deps.profileStore.getProfile(scope.employeeId),
        thread(scope),
      ]);
      const snapshot: ChatProcSnapshot = {
        profile: envelope("/proc/profile", scope, projectProfile(profile)),
        thread: envelope("/proc/thread", scope, turns),
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
        threadId ? deps.insightStore.listInsights({ employeeId: scope.employeeId, threadId, limit: limits.insights }) : [],
        threadId ? deps.feedbackStore.listFeedback({ employeeId: scope.employeeId, threadId, limit: limits.feedback }) : [],
      ]);
      return {
        profile: envelope("/proc/profile", scope, projectProfile(profile)),
        consent: envelope("/proc/consent", scope, {
          status: participant?.status,
          accepted: consent?.privacyVersion === currentPrivacyVersion,
          ...(consent ? { privacyVersion: consent.privacyVersion, acceptedAt: consent.acceptedAt } : {}),
        }),
        thread: envelope("/proc/thread", scope, turns),
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
            limit: limits.runCurrent,
          }),
        ),
        recent: envelope(
          "/run/recent",
          scope,
          await deps.auditEventStore.listRecent({
            employeeId: scope.employeeId,
            ...(scope.threadId ? { threadId: scope.threadId } : {}),
            limit: limits.runRecent,
          }),
        ),
      };
    },
  };
}

function boundTurns(turns: ConversationTurn[], limits: RuntimeProjectionLimits): { turns: ConversationTurn[]; truncated: boolean } {
  const newestFirst = [...turns].reverse();
  let characters = 0;
  let truncated = false;
  const retained: ConversationTurn[] = [];
  for (const turn of newestFirst) {
    const userText = sanitiseTurnText(turn.userText, limits.threadTurnTextCharacters);
    const agentResponse = sanitiseTurnText(turn.agentResponse, limits.threadTurnTextCharacters);
    if (userText.truncated || agentResponse.truncated) truncated = true;
    const size = Array.from(userText.text).length + Array.from(agentResponse.text).length;
    // Turns are evaluated newest-to-oldest: on overflow, retain the contiguous
    // newest suffix instead of creating holes or dropping the latest context.
    if (characters + size > limits.threadCharacters) {
      truncated = true;
      break;
    }
    retained.push({ ...turn, userText: userText.text, agentResponse: agentResponse.text });
    characters += size;
  }
  return { turns: retained.reverse(), truncated };
}

function sanitiseTurnText(text: string, maximumCharacters: number): { text: string; truncated: boolean } {
  const cleaned = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  const characters = Array.from(cleaned);
  return {
    text: characters.slice(0, maximumCharacters).join(""),
    truncated: characters.length > maximumCharacters,
  };
}
