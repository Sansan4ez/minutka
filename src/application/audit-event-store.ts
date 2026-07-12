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

export type AuditEventStore = {
  append(event: AuditEventRecord): Promise<void>;
  listCurrent(input: { requestId: string; limit: number }): Promise<AuditEventRecord[]>;
  listRecent(input: {
    employeeId: string;
    threadId?: string;
    limit: number;
  }): Promise<AuditEventRecord[]>;
};
