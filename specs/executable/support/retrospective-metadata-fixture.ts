import type { ConversationTurn } from "../../../src/application/conversation-store.js";
import type { WorkRetrospectiveEvent } from "../../../src/domain/work-retrospective.js";

export function retrospectiveMetadataFixture(employeeId = "employee_a", subjectKey = "00000000-0000-4000-8000-000000000001", companyId = "company_a", groupId = "group_a") {
  const scope = { employeeId, subjectKey, companyId, groupId, threadId: "thread_a" };
  const timestamp = "2026-08-26T12:00:00.000Z";
  const event: WorkRetrospectiveEvent = { ...scope, eventId: "event_question", episodeId: "episode_a", sourceMessageId: "m1", ordinal: 0, version: 1, expectedRevision: 0, timestamp,
    action: { type: "question_generated", question: { questionId: "question_a", text: "Как проверили результат?", sourceTurn: { messageId: "m1" }, target: { episodeId: "episode_a", revision: 0, stage: "value", sourceRefs: [{ type: "message", messageId: "m1" }] } } } };
  const consent: WorkRetrospectiveEvent = { ...event, eventId: "event_consent", ordinal: 1, action: { type: "follow_up_consent_changed", consent: { granted: true, sourceRef: { messageId: "m1" } } } };
  const turn: ConversationTurn = { messageId: "m1", employeeId, subjectKey, threadId: scope.threadId, userText: "Проверил отчёт. Да, вернёмся к нему.", agentResponse: "Как проверили результат?", timestamp, origin: "employee", retrospectiveEvents: [event, consent] };
  return { scope, turn, event };
}
