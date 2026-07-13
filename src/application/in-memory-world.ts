import type { Consent, Participant, UserProfile } from "../domain/employee.js";
import type { DomainEvent } from "../domain/events.js";
import type { StructuredInsight } from "../domain/insights.js";
import type { AuditEventRecord } from "./audit-event-store.js";
import type { FeedbackRecord } from "../domain/feedback.js";
import type { OnboardingDraft } from "./onboarding-types.js";

export type ChatMessage = {
  id: string;
  employeeId: string;
  threadId: string;
  text: string;
  response: string;
  timestamp: string;
};

export type InMemoryWorld = {
  messages: ChatMessage[];
  /** Legacy observable event fixture; application code writes AuditEventStore. */
  events: DomainEvent[];
  auditEvents: AuditEventRecord[];
  participants: Participant[];
  consents: Consent[];
  profiles: UserProfile[];
  onboardingDrafts: OnboardingDraft[];
  insights: StructuredInsight[];
  feedback: FeedbackRecord[];
  counters: { message: number; participant: number; insight: number; feedback: number };
  now: () => string;
};

export function createInMemoryWorld(
  now: () => string = () => new Date().toISOString(),
): InMemoryWorld {
  return {
    messages: [],
    events: [],
    auditEvents: [],
    participants: [],
    consents: [],
    profiles: [],
    onboardingDrafts: [],
    insights: [],
    feedback: [],
    counters: { message: 0, participant: 0, insight: 0, feedback: 0 },
    now,
  };
}
