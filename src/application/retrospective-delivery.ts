import { createHash } from "node:crypto";
import type { ProfileStore } from "./profile-store.js";
import type { RetrospectiveCanonicalStore } from "./work-retrospective-service.js";
import { projectRetrospectiveEvents } from "./work-retrospective-service.js";
import { sameScope } from "./retrospective-event-store.js";
import type { WorkRetrospectiveStore } from "./work-retrospective-store.js";
import type { RetrospectiveScope, WorkRetrospectiveEvent } from "../domain/work-retrospective.js";
import { calendarDateInIanaTimezone } from "../shared/iana-timezone.js";

export type ScheduledDeliveryProvenance = { processId: string; scheduleId?: string; scheduledFor?: string };
export type ResponseDeliveryReceipt = { employeeId: string; threadId: string; messageId: string; status: "delivered" | "failed" };
export type ResponseDeliveryOutcome = { status: "applied" | "replayed" | "forbidden" | "not_found" } | { status: "failed"; code: "persistence_error" };

/** Trusted transport callback, deliberately absent from model tools and HTTP DTOs. */
export function createRetrospectiveDelivery(input: {
  canonical: RetrospectiveCanonicalStore;
  episodes: WorkRetrospectiveStore;
  profiles: Pick<ProfileStore, "getParticipant" | "getProfile">;
  now?: () => string;
}) {
  let tail = Promise.resolve();
  const now = input.now ?? (() => new Date().toISOString());
  return {
    async record(receipt: ResponseDeliveryReceipt): Promise<ResponseDeliveryOutcome> {
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      try {
        const participant = await input.profiles.getParticipant(receipt.employeeId);
        if (!participant) return { status: "forbidden" };
        const scope: RetrospectiveScope = { employeeId: receipt.employeeId, threadId: receipt.threadId,
          companyId: participant.companyId, groupId: participant.groupId, subjectKey: participant.subjectKey };
        // Owner/thread predicates are applied by the store, not after reading a foreign turn.
        const turn = await input.canonical.getTurnByMessageId(receipt);
        if (!turn) return { status: "not_found" };
        if (turn.employeeId !== scope.employeeId || turn.threadId !== scope.threadId || turn.subjectKey !== scope.subjectKey
          || turn.retrospectiveEvents?.some((event) => !sameScope(event, scope))
          || (turn.retrospectiveDeliveryScope && !sameScope(turn.retrospectiveDeliveryScope, scope))) return { status: "forbidden" };
        const events = await input.canonical.readEvents({ scope, limit: 10001 });
        if (events.length > 10000) throw new Error("ledger capacity exceeded");
        const existing = events.filter((event) => event.sourceMessageId === turn.messageId && event.action.type === "response_delivery");
        // A canonical response has one final transport outcome. Replays never allocate new ordinals.
        if (existing.length) {
          if (existing.some((event) => event.action.type === "response_delivery" && event.action.status !== receipt.status)) return { status: "forbidden" };
          for (const event of existing) {
            const rebuilt = await input.episodes.rebuild({ scope, episodeId: event.episodeId });
            if (rebuilt.status === "failed") return { status: "failed", code: "persistence_error" };
          }
          return { status: "replayed" };
        }
        const questions = (turn.retrospectiveEvents ?? []).filter((event) => event.action.type === "question_generated");
        const scheduled = turn.origin === "scheduled" ? turn.scheduledProvenance : undefined;
        if (!questions.length && (!scheduled || !turn.retrospectiveDeliveryScope)) return { status: "applied" };
        const profile = await input.profiles.getProfile(scope.employeeId);
        if (!profile) return { status: "forbidden" };
        const timestamp = now();
        const localDate = calendarDateInIanaTimezone(timestamp, profile.timezone);
        const episodes = projectRetrospectiveEvents(events);
        const sources = questions.length ? questions : [undefined];
        let ordinal = Math.max(-1, ...events.filter((event) => event.sourceMessageId === turn.messageId).map((event) => event.ordinal)) + 1;
        const delivery: WorkRetrospectiveEvent[] = sources.map((source) => {
          const episode = episodes.find((value) => value.episodeId === source?.episodeId);
          const questionId = source?.action.type === "question_generated" ? source.action.question.questionId : undefined;
          const generatedEpisode = source ? projectRetrospectiveEvents(events.slice(0, events.findIndex((event) => event.eventId === source.eventId) + 1))
            .find((value) => value.episodeId === source.episodeId) : undefined;
          const episodeId = source?.episodeId ?? `delivery:${turn.messageId}`;
          return { ...scope, version: 1, timestamp, sourceMessageId: turn.messageId, episodeId, ordinal: ordinal++,
            eventId: createHash("sha256").update(JSON.stringify([scope, turn.messageId, questionId ?? null])).digest("hex"),
            expectedRevision: episode?.revision ?? 0,
            action: { type: "response_delivery", responseMessageId: turn.messageId, status: receipt.status, localDate,
              ...(questionId ? { questionId } : {}),
              ...(generatedEpisode?.questionBudget.weeklySession ? { sessionId: generatedEpisode.questionBudget.weeklySession.sessionId } : {}),
              ...(scheduled ? { scheduled } : {}) } };
        });
        await input.canonical.appendDeliveryEvents({ scope, sourceMessageId: turn.messageId, events: delivery });
        for (const event of delivery) {
          const rebuilt = await input.episodes.rebuild({ scope, episodeId: event.episodeId });
          if (rebuilt.status === "failed") return { status: "failed", code: "persistence_error" };
        }
        return { status: "applied" };
      } catch { return { status: "failed", code: "persistence_error" }; }
      finally { release(); }
    },
    async readDeliveries(request: { scope: RetrospectiveScope; localDate: string }) {
      const participant = await input.profiles.getParticipant(request.scope.employeeId);
      if (!participant || participant.companyId !== request.scope.companyId || participant.groupId !== request.scope.groupId
        || participant.subjectKey !== request.scope.subjectKey) return [];
      const events = await input.canonical.readEvents({ scope: request.scope, limit: 10001 });
      if (events.length > 10000) throw new Error("retrospective delivery read failed");
      return events.flatMap((event) => event.action.type === "response_delivery" && event.action.localDate === request.localDate
        && event.action.scheduled?.scheduleId && event.action.scheduled.scheduledFor
        && ["evening_reflection", "weekly_summary", "final_report"].includes(event.action.scheduled.processId)
        ? [{ processId: event.action.scheduled.processId as import("./retrospective-touch-policy.js").RetrospectiveTouchProcess,
          scheduleId: event.action.scheduled.scheduleId, scheduledFor: event.action.scheduled.scheduledFor, event }] : []);
    },
  };
}
