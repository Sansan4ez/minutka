import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ConversationTurn } from "./conversation-store.js";
import type { RetrospectiveScope, WorkRetrospectiveEvent } from "../domain/work-retrospective.js";
import { retrospectiveWeekKey, createWorkRetrospectiveService } from "./work-retrospective-service.js";
import { resolveWorkRetrospectivePolicy, type WorkRetrospectivePolicyStore } from "./work-retrospective-policy.js";

export const retrospectiveUpdateSchema = z.strictObject({
  question: z.strictObject({ text: z.string().trim().min(1).max(2000), stage: z.enum(["actions", "value", "future", "indicators"]) }).optional(),
  closeReason: z.enum(["answered", "topic_changed", "declined"]).optional(),
  followUpConsent: z.boolean().optional(),
  weeklyConsent: z.boolean().optional(),
  statement: z.strictObject({ text: z.string().trim().min(1).max(1000), stage: z.enum(["actions", "value", "future", "indicators"]), kind: z.enum(["employee_fact", "employee_interpretation", "intention", "agent_hypothesis"]) }).optional(),
  selectedStep: z.string().trim().min(1).max(1000).optional(),
  indicator: z.strictObject({ sign: z.string().min(1).max(500), meaning: z.string().min(1).max(500), reaction: z.string().min(1).max(500) }).optional(),
});
export type RetrospectiveUpdate = z.infer<typeof retrospectiveUpdateSchema>;
export type RetrospectiveRuntimeDependencies = {
  service: ReturnType<typeof createWorkRetrospectiveService>;
  policies: WorkRetrospectivePolicyStore;
};

/** Model commands contain neither identity nor a selectable target. Events are
 * staged until the exact final response can be appended with its canonical turn. */
export async function createWorkRetrospectiveRequest(input: {
  scope: RetrospectiveScope; messageId: string; now: string; localDate: string;
  dependencies: RetrospectiveRuntimeDependencies;
  origin?: import("../domain/work-retrospective.js").ConversationTurnOrigin;
  scheduled?: import("./retrospective-delivery.js").ScheduledDeliveryProvenance;
}) {
  const { scope, messageId, now, localDate, dependencies } = input;
  const policy = await resolveWorkRetrospectivePolicy(dependencies.policies, scope, now);
  const availability = await dependencies.policies.availability?.(scope);
  const read = await dependencies.service.readEpisodes({ scope, limit: 100 });
  let episode = "value" in read ? read.value.find((value) => value.status === "active") : undefined;
  const events: WorkRetrospectiveEvent[] = [];
  const activityRefs: { activityId: string; revision: number }[] = [];
  const add = (action: WorkRetrospectiveEvent["action"]) => {
    events.push({ ...scope, eventId: randomUUID(), episodeId: episode!.episodeId, sourceMessageId: messageId,
      ordinal: events.length, version: 1, expectedRevision: episode!.revision + events.length, timestamp: now, action });
  };
  if (episode?.pendingQuestion && (!policy.enabled || episode.questionBudget.localDate !== localDate || now >= episode.period.end)) {
    add({ type: "question_closed", questionId: episode.pendingQuestion.questionId,
      reason: now >= episode.period.end ? "cycle_ended" : !policy.enabled ? "policy_disabled" : "new_day", localDate });
  }
  if (policy.enabled && episode && episode.questionBudget.localDate !== localDate && !events.length) add({ type: "question_closed", questionId: episode.pendingQuestion?.questionId ?? "day-boundary", reason: "new_day", localDate });
  const enabled = policy.enabled && "value" in read;
  const context = await dependencies.service.readContext({ scope, enabled: !!policy.policy && "value" in read, now, localDate });
  return {
    enabled,
    availability,
    historicalAvailable: !!policy.policy && "value" in read,
    bindCollectedActivities(ids: string[]) { for (const activityId of ids) if (!activityRefs.some((ref) => ref.activityId === activityId)) activityRefs.push({ activityId, revision: 1 }); },
    bindCorrectedActivity(activityId: string, revision: number) {
      // Only application-confirmed mutations of an already bound target advance it.
      const bound = activityRefs.find((ref) => ref.activityId === activityId)
        ?? episode?.activityRefs.find((ref) => ref.activityId === activityId);
      if (!bound || revision <= bound.revision) return;
      const staged = activityRefs.find((ref) => ref.activityId === activityId);
      if (staged) staged.revision = revision;
      else activityRefs.push({ activityId, revision });
    },
    scheduled: input.scheduled,
    context: "value" in context ? context.value : "{}",
    async update(raw: RetrospectiveUpdate) {
      const parsed = retrospectiveUpdateSchema.safeParse(raw);
      if (!enabled || !policy.enabled) return { status: "forbidden" as const };
      if (!parsed.success || events.some((event) => event.action.type === "question_generated")) return { status: "failed" as const, code: "validation_error" as const };
      const command = parsed.data;
      if (command.weeklyConsent !== undefined && (input.origin !== "employee" || input.scheduled)) return { status: "forbidden" as const };
      if (command.weeklyConsent === true && "value" in read && read.value.some((value) => value.questionBudget.weeklySession?.weekKey === retrospectiveWeekKey(localDate))) return { status: "forbidden" as const };
      if (command.weeklyConsent === false || command.closeReason === "declined") command.question = undefined;
      // A scheduled invitation cannot replace an employee's unanswered question.
      // Statements and factual collection remain available on this same request.
      if (input.scheduled?.retrospectiveTouch?.preservePendingQuestion && episode?.pendingQuestion
        && (command.question || command.closeReason)) return { status: "forbidden" as const };
      if (!Object.keys(command).length) return { status: "failed" as const, code: "validation_error" as const };
      if (!episode) {
        episode = { ...scope, episodeId: randomUUID(), period: policy.policy.period, methodVersion: policy.policy.methodVersion,
          messageRefs: [{ messageId }], activityRefs: structuredClone(activityRefs), statements: { actions: [], value: [], future: [], indicators: [] },
          status: "active", revision: 0, questionBudget: { localDate, dailyDelivered: 0 } };
        add({ type: "episode_selected", episode });
      }
      if (command.statement || command.selectedStep || command.indicator || activityRefs.some((ref) => !episode!.activityRefs.some((old) => old.activityId === ref.activityId && old.revision === ref.revision))) {
        const updated = structuredClone(episode);
        for (const ref of activityRefs) {
          const old = updated.activityRefs.find((value) => value.activityId === ref.activityId);
          if (old) old.revision = ref.revision;
          else updated.activityRefs.push({ ...ref });
        }
        const sourceRefs = [{ type: "message" as const, messageId }];
        if (!updated.messageRefs.some((ref) => ref.messageId === messageId)) updated.messageRefs.push({ messageId });
        if (command.statement) updated.statements[command.statement.stage].push({ statementId: randomUUID(), text: command.statement.text, kind: command.statement.kind, sourceRefs });
        if (command.selectedStep) updated.selectedStep = { statementId: randomUUID(), text: command.selectedStep, kind: "intention", sourceRefs };
        if (command.indicator) updated.indicator = { ...command.indicator, sourceRefs };
        add({ type: "episode_updated", episode: updated });
        episode = updated;
      }
      if (command.closeReason && episode.pendingQuestion) add({ type: "question_closed", questionId: episode.pendingQuestion.questionId, reason: command.closeReason });
      if (command.weeklyConsent === true) add({ type: "weekly_session_started", sessionId: randomUUID(), consent: { granted: true, sourceRef: { messageId } }, localDate, weekKey: retrospectiveWeekKey(localDate) });
      if (command.weeklyConsent === false || command.closeReason === "declined") add({ type: "weekly_session_closed" });
      if (command.followUpConsent !== undefined) add({ type: "follow_up_consent_changed", consent: { granted: command.followUpConsent, sourceRef: { messageId } } });
      if (command.question) add({ type: "question_generated", question: { questionId: randomUUID(), text: command.question.text,
        sourceTurn: { messageId }, target: { episodeId: episode.episodeId, revision: episode.revision + events.length,
          stage: command.question.stage, sourceRefs: episode.messageRefs.map((ref) => ({ type: "message", ...ref })) } } });
      return { status: "staged" as const, question: command.question?.text, instruction: "Include this exact question in the final response. Persistence and delivery are not yet confirmed; do not promise a follow-up." };
    },
    async save(turn: ConversationTurn) {
      if (!episode || !events.length) return undefined;
      const question = events.find((event) => event.action.type === "question_generated");
      if (question?.action.type === "question_generated" && !turn.agentResponse.includes(question.action.question.text)) return { status: "failed" as const, code: "validation_error" as const };
      return dependencies.service.applyTurn({ scope, episodeId: episode.episodeId, expectedRevision: episode.revision, events }, turn);
    },
  };
}
export type WorkRetrospectiveCapabilities = {
  scheduled?: import("./retrospective-delivery.js").ScheduledDeliveryProvenance;
  read(): Promise<string>;
  update(input: RetrospectiveUpdate): Promise<unknown>;
};
