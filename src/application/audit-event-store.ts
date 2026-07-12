export type AuditEventType =
  | "invite_opened"
  | "privacy_explanation_shown"
  | "consent_accepted"
  | "profile_updated"
  | "onboarding_completed"
  | "chat_received"
  | "chat_response_generated"
  | "work_boundary_applied"
  | "insight_recorded"
  | "insight_extraction_failed"
  | "feedback_received"
  | "agent_manual_load_failed"
  | "employee_data_deleted";

export type SafeAuditMetadata = Record<string, string | number | boolean | string[]>;

export type AuditEventRecord = {
  id: string;
  requestId: string;
  type: AuditEventType;
  employeeId?: string;
  threadId?: string;
  messageId?: string;
  occurredAt: string;
  metadata: SafeAuditMetadata;
};

const allowedMetadataKeys: Record<AuditEventType, readonly string[]> = {
  invite_opened: [],
  privacy_explanation_shown: ["privacyVersion"],
  consent_accepted: ["privacyVersion"],
  profile_updated: ["changedFields"],
  onboarding_completed: ["persona"],
  chat_received: [],
  chat_response_generated: [],
  work_boundary_applied: ["reason", "selectedProcessIds"],
  insight_recorded: ["insightId", "kind"],
  insight_extraction_failed: [],
  feedback_received: ["feedbackId", "rating", "source", "selectedProcessIds"],
  agent_manual_load_failed: [],
  employee_data_deleted: [],
};

/** Enforces per-event allow-lists before an audit record reaches a store. */
export function safeAuditMetadata(type: AuditEventType, metadata: SafeAuditMetadata): SafeAuditMetadata {
  const allowed = new Set(allowedMetadataKeys[type]);
  const safe: SafeAuditMetadata = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (allowed.has(key)) safe[key] = value;
  }
  return safe;
}

export type AuditEventStore = {
  append(event: AuditEventRecord): Promise<void>;
  listCurrent(input: { requestId: string; limit: number }): Promise<AuditEventRecord[]>;
  listRecent(input: {
    employeeId: string;
    threadId?: string;
    limit: number;
  }): Promise<AuditEventRecord[]>;
};
