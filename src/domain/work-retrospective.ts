/** Research-only references; never authorization credentials. */
export type RetrospectiveScope = {
  employeeId: string;
  companyId: string;
  groupId: string;
  subjectKey: string;
  threadId: string;
};
export type RetrospectiveMessageRef = { messageId: string };
export type RetrospectiveActivityRef = { activityId: string; revision: number };
export type RetrospectiveSourceRef =
  | ({ type: "message" } & RetrospectiveMessageRef)
  | ({ type: "activity" } & RetrospectiveActivityRef);
export type RetrospectiveStatementKind =
  | "employee_fact" | "employee_interpretation" | "intention" | "agent_hypothesis";
export type RetrospectiveStage = "actions" | "value" | "future" | "indicators";
export type RetrospectiveStatement = {
  statementId: string;
  text: string;
  kind: RetrospectiveStatementKind;
  sourceRefs: RetrospectiveSourceRef[];
};
export type RetrospectiveIndicator = {
  sign: string;
  meaning: string;
  reaction: string;
  sourceRefs: RetrospectiveSourceRef[];
};
export type RetrospectiveConsent = {
  granted: boolean;
  sourceRef: RetrospectiveMessageRef;
};
export type RetrospectiveQuestion = {
  questionId: string;
  text: string;
  sourceTurn: RetrospectiveMessageRef;
  target: {
    episodeId: string;
    revision: number;
    stage: RetrospectiveStage;
    sourceRefs: RetrospectiveSourceRef[];
  };
};
/** Delivered questions only. Weekly consent replaces, not adds to, the daily budget. */
export type RetrospectiveQuestionBudget = {
  localDate: string;
  dailyDelivered: number;
  weeklySession?: {
    sessionId: string;
    consent: RetrospectiveConsent;
    delivered: number;
  };
};
export type WorkRetrospectiveEpisode = RetrospectiveScope & {
  episodeId: string;
  period: { start: string; end: string };
  methodVersion: string;
  messageRefs: RetrospectiveMessageRef[];
  activityRefs: RetrospectiveActivityRef[];
  statements: Record<RetrospectiveStage, RetrospectiveStatement[]>;
  selectedStep?: RetrospectiveStatement & { kind: "intention" };
  indicator?: RetrospectiveIndicator;
  followUpConsent?: RetrospectiveConsent;
  status: "active" | "paused" | "completed" | "declined";
  revision: number;
  pendingQuestion?: RetrospectiveQuestion;
  questionBudget: RetrospectiveQuestionBudget;
};
export type WorkRetrospectivePolicy = {
  companyId: string;
  groupId: string;
  enabled: boolean;
  period: { start: string; end: string };
  methodVersion: string;
};
export type ConversationTurnOrigin = "employee" | "scheduled" | "unknown";

/** Payloads are produced by typed application commands, never chosen as scope by a model. */
export type WorkRetrospectiveEventAction =
  | { type: "episode_selected"; episode: WorkRetrospectiveEpisode }
  | { type: "episode_updated"; episode: WorkRetrospectiveEpisode }
  | { type: "episode_status_changed"; status: WorkRetrospectiveEpisode["status"] }
  | { type: "question_generated"; question: RetrospectiveQuestion }
  | { type: "question_closed"; questionId: string; reason: "answered" | "topic_changed" | "declined" | "new_day" | "cycle_ended" | "policy_disabled"; localDate?: string }
  | { type: "follow_up_consent_changed"; consent: RetrospectiveConsent }
  | { type: "weekly_session_started"; sessionId: string; consent: RetrospectiveConsent }
  | { type: "response_delivery"; responseMessageId: string; questionId?: string; status: "delivered" | "failed"; localDate: string; sessionId?: string; scheduled?: { processId: string; scheduleId?: string; scheduledFor?: string } };
/** Unique key: scope + sourceMessageId + ordinal. Append with the canonical turn atomically.
 * Rebuild the episode projection in canonical event order; generation is not delivery.
 */
export type WorkRetrospectiveEvent = RetrospectiveScope & {
  eventId: string;
  episodeId: string;
  sourceMessageId: string;
  ordinal: number;
  version: 1;
  expectedRevision: number;
  timestamp: string;
  action: WorkRetrospectiveEventAction;
};
/** Bound by application from request scope and current durable refs, not from model output. */
export type RetrospectiveBoundTarget = {
  episodeId: string;
  revision: number;
  sourceRefs: RetrospectiveSourceRef[];
  activityRefs: RetrospectiveActivityRef[];
  statements: WorkRetrospectiveEpisode["statements"];
};
export type RetrospectiveExtractionInput = {
  currentText: string;
  question: RetrospectiveQuestion;
  boundTarget: RetrospectiveBoundTarget;
};
export const retrospectiveContextMaxCharacters = 6000;
export const retrospectiveDailyQuestionLimit = 4;
export const retrospectiveWeeklyQuestionLimit = 8;
