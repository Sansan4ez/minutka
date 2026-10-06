import { isDeepStrictEqual } from "node:util";
import { sanitizeResearchText } from "./research-trace-store.js";
import type { ConversationTurn } from "./conversation-store.js";
import { PersistenceError } from "./persistence-error.js";
import type { RetrospectiveReadRequest } from "./work-retrospective-store.js";
import type { RetrospectiveScope, WorkRetrospectiveEvent } from "../domain/work-retrospective.js";

/** Canonical ledger only; episode projections and their revision rules are separate. */
export type RetrospectiveEventStore = {
  readEvents(request: RetrospectiveReadRequest & { episodeId?: string }): Promise<WorkRetrospectiveEvent[]>;
  /** Delivery is appended after transport outcome, never inferred from generation. */
  appendDeliveryEvents(request: { scope: RetrospectiveScope; sourceMessageId: string; events: WorkRetrospectiveEvent[] }): Promise<void>;
};
export type TurnMetadata = {
  version: 1;
  origin?: ConversationTurn["origin"];
  retrospectiveDeliveryScope?: ConversationTurn["retrospectiveDeliveryScope"];
  scheduledProvenance?: ConversationTurn["scheduledProvenance"];
  retrospectiveEvents?: WorkRetrospectiveEvent[];
  deliveryEvents?: WorkRetrospectiveEvent[];
};
export function metadataFor(turn: ConversationTurn): TurnMetadata | null {
  if (turn.origin === undefined && turn.retrospectiveEvents === undefined) return null;
  return sanitizeRetrospectiveMetadata({ version: 1, ...(turn.origin === undefined ? {} : { origin: turn.origin }),
    ...(turn.retrospectiveEvents === undefined ? {} : { retrospectiveEvents: turn.retrospectiveEvents }),
    ...(turn.retrospectiveDeliveryScope ? { retrospectiveDeliveryScope: turn.retrospectiveDeliveryScope } : {}),
    ...(turn.scheduledProvenance ? { scheduledProvenance: turn.scheduledProvenance } : {}) });
}
/** Sanitize text values recursively, without altering JSON syntax or recording raw text in audit. */
export function sanitizeRetrospectiveMetadata<T>(value: T): T {
  const visit = (item: unknown): unknown => typeof item === "string" ? sanitizeResearchText(item)
    : Array.isArray(item) ? item.map(visit)
    : item && typeof item === "object" ? Object.fromEntries(Object.entries(item).map(([key, val]) => [key, typeof val === "string" ? (["text", "quote", "statement", "reason", "sign", "meaning", "reaction"].includes(key) ? sanitizeResearchText(val) : val) : visit(val)])) : item;
  return visit(value) as T;
}
export function sameScope(a: RetrospectiveScope, b: RetrospectiveScope): boolean {
  return a.employeeId === b.employeeId && a.companyId === b.companyId && a.groupId === b.groupId
    && a.subjectKey === b.subjectKey && a.threadId === b.threadId;
}
export function validateEvents(turn: ConversationTurn, events: WorkRetrospectiveEvent[]): void {
  const keys = new Set<number>();
  const ids = new Set<string>();
  const first = events[0];
  for (const event of events) {
    if (event.version !== 1 || !Number.isInteger(event.ordinal) || event.ordinal < 0
      || !Number.isInteger(event.expectedRevision) || event.expectedRevision < 0
      || !event.eventId || !event.episodeId || !Number.isFinite(Date.parse(event.timestamp))
      || event.sourceMessageId !== turn.messageId || event.employeeId !== turn.employeeId
      || event.threadId !== turn.threadId || event.subjectKey !== turn.subjectKey
      || (first && !sameScope(first, event)) || keys.has(event.ordinal) || ids.has(event.eventId)) {
      throw new PersistenceError("persistence_conflict");
    }
    if (event.action.type === "weekly_session_started" && (turn.origin !== "employee" || event.action.consent.sourceRef.messageId !== turn.messageId)) throw new PersistenceError("persistence_conflict");
    keys.add(event.ordinal); ids.add(event.eventId);
  }
}
export function mergeDeliveryEvents(turn: ConversationTurn, metadata: TurnMetadata | null,
  scope: RetrospectiveScope, events: WorkRetrospectiveEvent[]): TurnMetadata {
  const initial = metadata?.retrospectiveEvents ?? [];
  const delivery = metadata?.deliveryEvents ?? [];
  validateEvents(turn, [...initial, ...delivery]);
  validateEvents(turn, events);
  const scheduledReceipt = turn.origin === "scheduled" && metadata?.scheduledProvenance
    && metadata.retrospectiveDeliveryScope && sameScope(metadata.retrospectiveDeliveryScope, scope);
  if ((!initial.length && !scheduledReceipt) || !initial.every((event) => sameScope(event, scope))
    || !events.every((event) => sameScope(event, scope) && event.action.type === "response_delivery"
      && event.action.responseMessageId === turn.messageId
      && isDeepStrictEqual(event.action.scheduled, metadata?.scheduledProvenance)
      && (!event.action.questionId || initial.some((source) => source.action.type === "question_generated"
        && source.episodeId === event.episodeId && source.action.question.questionId === (event.action.type === "response_delivery" ? event.action.questionId : undefined)))
      && (initial.some((source) => source.episodeId === event.episodeId)
        || (scheduledReceipt && event.action.type === "response_delivery" && !event.action.questionId)))) {
    throw new PersistenceError("persistence_conflict");
  }
  const merged = [...delivery];
  for (const event of events) {
    const existing = [...initial, ...merged].find((candidate) => candidate.ordinal === event.ordinal || candidate.eventId === event.eventId
      || (candidate.action.type === "response_delivery" && event.action.type === "response_delivery"
        && candidate.action.responseMessageId === event.action.responseMessageId && candidate.action.questionId === event.action.questionId));
    if (existing) {
      if (!isDeepStrictEqual(existing, event)) throw new PersistenceError("persistence_conflict");
    } else merged.push(structuredClone(event));
  }
  return sanitizeRetrospectiveMetadata({ ...metadata!, version: 1, deliveryEvents: merged });
}
export function selectEvents(events: WorkRetrospectiveEvent[], request: RetrospectiveReadRequest & { episodeId?: string }): WorkRetrospectiveEvent[] {
  return events.filter((event) => sameScope(event, request.scope)
    && (!request.episodeId || event.episodeId === request.episodeId)
    && (!request.period || (Date.parse(event.timestamp) >= Date.parse(request.period.start) && Date.parse(event.timestamp) <= Date.parse(request.period.end))))
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.sourceMessageId.localeCompare(b.sourceMessageId) || a.ordinal - b.ordinal)
    .slice(0, Math.max(0, request.limit)).map((event) => sanitizeRetrospectiveMetadata(event));
}
