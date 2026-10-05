import { z } from "zod";
import type { ConversationTurn } from "./conversation-store.js";
import type {
  RetrospectiveScope, WorkRetrospectiveEpisode, WorkRetrospectiveEvent,
} from "../domain/work-retrospective.js";

const id = z.string().trim().min(1);
const revision = z.number().int().nonnegative();
const messageRef = z.strictObject({ messageId: id });
const activityRef = z.strictObject({ activityId: id, revision });
const sourceRef = z.discriminatedUnion("type", [
  messageRef.extend({ type: z.literal("message") }),
  activityRef.extend({ type: z.literal("activity") }),
]);
const sources = z.array(sourceRef).min(1);
const statement = z.strictObject({
  statementId: id, text: id,
  kind: z.enum(["employee_fact", "employee_interpretation", "intention", "agent_hypothesis"]),
  sourceRefs: sources,
});
const consent = z.strictObject({ granted: z.boolean(), sourceRef: messageRef });
const period = z.strictObject({ start: z.iso.datetime({ offset: true }), end: z.iso.datetime({ offset: true }) })
  .refine((value) => Date.parse(value.start) <= Date.parse(value.end), "Period end precedes start");
export const retrospectiveQuestionSchema = z.strictObject({
  questionId: id, text: id, sourceTurn: messageRef,
  target: z.strictObject({
    episodeId: id, revision,
    stage: z.enum(["actions", "value", "future", "indicators"]), sourceRefs: sources,
  }),
});
export const retrospectiveIndicatorSchema = z.strictObject({
  sign: id, meaning: id, reaction: id, sourceRefs: sources,
});
export const workRetrospectiveEpisodeSchema = z.strictObject({
  employeeId: id, companyId: id, groupId: id, subjectKey: id, threadId: id,
  episodeId: id, period, methodVersion: id,
  messageRefs: z.array(messageRef), activityRefs: z.array(activityRef),
  statements: z.strictObject({
    actions: z.array(statement), value: z.array(statement),
    future: z.array(statement), indicators: z.array(statement),
  }),
  selectedStep: statement.extend({ kind: z.literal("intention") }).optional(),
  indicator: retrospectiveIndicatorSchema.optional(), followUpConsent: consent.optional(),
  status: z.enum(["active", "paused", "completed", "declined"]), revision,
  pendingQuestion: retrospectiveQuestionSchema.optional(),
  questionBudget: z.strictObject({
    localDate: z.iso.date(), dailyDelivered: revision,
    weeklySession: z.strictObject({ sessionId: id, consent, delivered: revision }).optional(),
  }),
});
export const workRetrospectivePolicySchema = z.strictObject({
  companyId: id, groupId: id, enabled: z.boolean(), period, methodVersion: id,
  invalidatedAt: z.iso.datetime({ offset: true }).optional(),
});

export type RetrospectiveOutcome<T> =
  | { status: "applied" | "replayed"; value: T }
  | { status: "stale" | "not_found" | "forbidden" }
  | { status: "failed"; code: "validation_error" | "context_budget_error" | "persistence_unavailable" | "persistence_error" };
export type RetrospectiveReadRequest = {
  scope: RetrospectiveScope;
  period?: { start: string; end: string };
  limit: number;
};
export type RetrospectiveCommand = {
  scope: RetrospectiveScope;
  episodeId: string;
  expectedRevision: number;
  events: WorkRetrospectiveEvent[];
};
/** Application ports only: no runtime enabling in this contract slice. */
export type WorkRetrospectiveUseCases = {
  readEpisode(request: { scope: RetrospectiveScope; episodeId: string }): Promise<RetrospectiveOutcome<WorkRetrospectiveEpisode>>;
  readEpisodes(request: RetrospectiveReadRequest): Promise<RetrospectiveOutcome<WorkRetrospectiveEpisode[]>>;
  apply(command: RetrospectiveCommand): Promise<RetrospectiveOutcome<WorkRetrospectiveEpisode>>;
};
/** Adapter must enforce request scope, optimistic revision and event replay keys.
 * At most one pending question per employee/thread across all episodes.
 * Projection is disposable; canonical turn/events are committed together.
 */
export type WorkRetrospectiveStore = {
  appendTurnWithEvents(input: RetrospectiveCommand & { turn: ConversationTurn }): Promise<RetrospectiveOutcome<WorkRetrospectiveEvent[]>>;
  readEvents(request: RetrospectiveReadRequest & { episodeId: string }): Promise<RetrospectiveOutcome<WorkRetrospectiveEvent[]>>;
  readEpisode(request: { scope: RetrospectiveScope; episodeId: string }): Promise<RetrospectiveOutcome<WorkRetrospectiveEpisode>>;
  readEpisodes(request: RetrospectiveReadRequest): Promise<RetrospectiveOutcome<WorkRetrospectiveEpisode[]>>;
  rebuild(request: { scope: RetrospectiveScope; episodeId: string }): Promise<RetrospectiveOutcome<WorkRetrospectiveEpisode>>;
};
