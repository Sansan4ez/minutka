import type { Consent, Participant, UserProfile } from "../domain/employee.js";
import type { DomainEvent } from "../domain/events.js";
import type { StructuredInsight } from "../domain/insights.js";
import type { AuditEventRecord } from "./audit-event-store.js";
import type { FeedbackRecord } from "../domain/feedback.js";
import type { OnboardingDraft } from "./onboarding-types.js";
import type { ThreadSummary } from "./thread-summary-store.js";
import type { InMemoryTenantDirectories } from "./in-memory-tenant-directory-store.js";

export type ChatMessage = {
  id: string;
  employeeId: string;
  subjectKey: string;
  threadId: string;
  text: string;
  response: string;
  timestamp: string;
};

export type InMemoryWorld = {
  messages: ChatMessage[];
  threadSummaries: ThreadSummary[];
  /** Legacy observable event fixture; application code writes AuditEventStore. */
  events: DomainEvent[];
  auditEvents: AuditEventRecord[];
  participants: Participant[];
  consents: Consent[];
  profiles: UserProfile[];
  onboardingDrafts: OnboardingDraft[];
  tenantDirectories: InMemoryTenantDirectories;
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
    threadSummaries: [],
    events: [],
    auditEvents: [],
    participants: [],
    consents: [],
    profiles: [],
    onboardingDrafts: [],
    tenantDirectories: {
      groups: [{ id: "default_group", companyId: "default_company" }],
      roles: [{ id: "default_role", companyId: "default_company", name: "Участник" }],
    },
    insights: [],
    feedback: [],
    counters: { message: 0, participant: 0, insight: 0, feedback: 0 },
    now,
  };
}
