import type { DomainEvent } from "../domain/events.js";
import type { InMemoryWorld } from "./in-memory-world.js";
import { safeAuditMetadata, type AuditEventRecord, type AuditEventStore } from "./audit-event-store.js";

/**
 * The legacy DomainEvent array is retained strictly as an executable-spec
 * inspection fixture. Production application code only observes this store.
 */
export function createInMemoryAuditEventStore(world: InMemoryWorld): AuditEventStore {
  return {
    async append(event) {
      const safeEvent = { ...event, metadata: safeAuditMetadata(event.type, event.metadata) };
      world.auditEvents.push(safeEvent);
      const legacy = toLegacyEvent(safeEvent);
      if (legacy) world.events.push(legacy);
    },
    async listCurrent({ requestId, limit }) {
      return world.auditEvents.filter((event) => event.requestId === requestId).slice(-Math.max(0, limit)).map(copy);
    },
    async listRecent({ employeeId, threadId, limit }) {
      return world.auditEvents.filter((event) => event.employeeId === employeeId && (threadId === undefined || event.threadId === threadId)).slice(-Math.max(0, limit)).map(copy);
    },
  };
}

function copy(event: AuditEventRecord): AuditEventRecord { return { ...event, metadata: { ...event.metadata } }; }

function toLegacyEvent(event: AuditEventRecord): DomainEvent | undefined {
  const employeeId = event.employeeId ?? "";
  const timestamp = event.occurredAt;
  switch (event.type) {
    case "invite_opened": return { type: "InviteOpened", employeeId, inviteCode: "[redacted]", timestamp };
    case "privacy_explanation_shown": return { type: "PrivacyExplanationShown", employeeId, privacyVersion: String(event.metadata.privacyVersion ?? "privacy-v1"), timestamp };
    case "consent_accepted": return { type: "ConsentAccepted", employeeId, privacyVersion: String(event.metadata.privacyVersion ?? "privacy-v1"), timestamp };
    case "profile_updated": return { type: "UserProfileUpdated", employeeId, changedFields: (event.metadata.changedFields as string[] | undefined) ?? [], timestamp };
    case "onboarding_completed": return { type: "OnboardingCompleted", employeeId, persona: String(event.metadata.persona) as "support" | "efficiency", timestamp };
    case "chat_received": return { type: "ChatMessageReceived", employeeId, threadId: event.threadId ?? "", text: "[private]", inputModality: (event.metadata.inputModality === "voice" ? "voice" : "text"), timestamp };
    case "request_integrity_denied": return undefined;
    case "chat_response_generated": return { type: "ChatResponseGenerated", employeeId, threadId: event.threadId ?? "", response: "[private]", timestamp };
    case "work_boundary_applied": return { type: "WorkBoundaryApplied", employeeId, threadId: event.threadId ?? "", reason: String(event.metadata.reason) as never, selectedProcessIds: event.metadata.selectedProcessIds as never, timestamp };
    case "insight_recorded": return { type: "InsightRecorded", employeeId, threadId: event.threadId ?? "", insightId: String(event.metadata.insightId), kind: String(event.metadata.kind) as never, timestamp };
    case "insight_extraction_failed": return { type: "InsightExtractionFailed", employeeId, threadId: event.threadId ?? "", reason: "redacted", timestamp };
    case "feedback_received": return { type: "FeedbackReceived", feedbackId: String(event.metadata.feedbackId), employeeId, threadId: event.threadId ?? "", targetMessageId: event.messageId ?? "", rating: String(event.metadata.rating) as never, source: String(event.metadata.source) as never, timestamp };
    default: return undefined;
  }
}
