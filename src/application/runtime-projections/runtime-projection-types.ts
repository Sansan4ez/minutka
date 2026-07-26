import type { ConversationDecision } from "../../domain/conversation-decision.js";
import type { FeedbackRecord } from "../../domain/feedback.js";
import type { StructuredInsight } from "../../domain/insights.js";
import type { AuditEventRecord } from "../audit-event-store.js";
import type { ConversationTurn } from "../conversation-store.js";
import type { Consent, OnboardingStatus, UserProfile } from "../../domain/employee.js";
import type { ThreadSummary } from "../thread-summary-store.js";

export const allowedRuntimePaths = [
  "/proc/profile",
  "/proc/consent",
  "/proc/thread",
  "/proc/decision",
  "/proc/insights",
  "/proc/feedback",
  "/run/current",
  "/run/recent",
] as const;

export type AllowedRuntimePath = (typeof allowedRuntimePaths)[number];

export type RuntimeProjection<T> = {
  schemaVersion: 1;
  path: AllowedRuntimePath;
  generatedAt: string;
  scope: {
    employeeId: string;
    threadId?: string;
    requestId: string;
    purpose: "chat" | "feedback" | "onboarding" | "audit";
  };
  data: T;
};

export type ChatProcSnapshot = {
  profile: RuntimeProjection<ProfileProjection | null>;
  thread: RuntimeProjection<ThreadProjection>;
};

export type ProcSnapshot = ChatProcSnapshot & {
  consent: RuntimeProjection<ConsentProjection>;
  insights: RuntimeProjection<StructuredInsight[]>;
  feedback: RuntimeProjection<FeedbackRecord[]>;
};

export type ProfileProjection = Pick<
  UserProfile,
  "preferredName" | "assistantName" | "addressForm" | "persona" | "responseLength" | "timezone" |
  "role" | "typicalTasks" | "aiLevel" | "preferredCheckinsPerDay"
>;

export type ConsentProjection = {
  status?: OnboardingStatus;
  accepted: boolean;
  privacyVersion?: Consent["privacyVersion"];
  acceptedAt?: string;
};

export type ThreadProjection = { summary?: ThreadSummary; turns: ConversationTurn[]; truncated: boolean };
export type DecisionProjection = ConversationDecision;
export type RunSnapshot = {
  current: RuntimeProjection<AuditEventRecord[]>;
  recent: RuntimeProjection<AuditEventRecord[]>;
};
