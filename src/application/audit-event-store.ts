export type AuditEventType =
  | "invite_opened"
  | "privacy_explanation_shown"
  | "consent_accepted"
  | "profile_updated"
  | "onboarding_completed"
  | "chat_received"
  | "request_integrity_denied"
  | "chat_response_generated"
  | "work_boundary_applied"
  | "insight_recorded"
  | "insight_extraction_failed"
  | "feedback_received"
  | "agent_manual_load_failed"
  | "idea_captured"
  | "idea_deletion_proposed"
  | "idea_deletion_decided"
  | "idea_deletion_undone"
  | "document_tool_used"
  | "context_document_mutated"
  | "context_projection_degraded"
  | "overflow_recovery"
  | "thread_summary_updated"
  | "thread_summary_failed"
  | "task_mutation_proposed"
  | "task_mutation_decided"
  | "task_mutation_undone"
  | "usage_soft_limit_exceeded"
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
  chat_received: ["inputModality"],
  request_integrity_denied: ["reason"],
  chat_response_generated: [],
  work_boundary_applied: ["reason", "selectedProcessIds"],
  insight_recorded: ["insightId", "kind"],
  insight_extraction_failed: [],
  feedback_received: ["feedbackId", "rating", "source"],
  agent_manual_load_failed: [],
  idea_captured: ["ideaId", "recordType", "sourceKind"],
  idea_deletion_proposed: ["ideaId", "recordType", "result", "confirmationId"],
  idea_deletion_decided: ["ideaId", "recordType", "result", "confirmationId"],
  idea_deletion_undone: ["ideaId", "recordType", "result"],
  document_tool_used: ["operation", "resultCount", "truncated", "outcome", "path", "totalCharacters", "returnedCharacters", "nextOffset", "reason"],
  context_document_mutated: ["operation", "path", "outcome", "version", "confirmationId"],
  context_projection_degraded: ["sourceId", "reason", "ceiling", "actualCharacters", "includedCharacters", "documentCount", "affectedCount"],
  overflow_recovery: ["reason", "attempt", "recordsCeiling", "historyCeiling", "contextIndexCeiling"],
  thread_summary_updated: ["turnCount", "summaryCharacters"],
  thread_summary_failed: ["reason", "turnCount", "previousCharacters"],
  task_mutation_proposed: ["confirmationId", "actionKind", "status", "taskId"],
  task_mutation_decided: ["confirmationId", "actionKind", "status", "result", "taskId"],
  task_mutation_undone: ["actionKind", "status", "taskId", "ideaStatusRestored"],
  usage_soft_limit_exceeded: ["month", "source", "inputTokens", "outputTokens", "totalTokens", "cachedInputTokens", "cachedInputUnknownRecords", "estimatedCostUsdMicros", "softLimitUsdMicros"],
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
  /** Returns the newest `limit` events for the request in chronological order. */
  listCurrent(input: { requestId: string; limit: number }): Promise<AuditEventRecord[]>;
  listRecent(input: {
    employeeId: string;
    threadId?: string;
    limit: number;
  }): Promise<AuditEventRecord[]>;
};
