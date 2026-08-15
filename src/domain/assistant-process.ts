export const assistantProcessIds = [
  "core",
  "inbox_capture",
  "knowledge_lookup",
  "morning_activity_collection",
  "consent_and_privacy",
  "day_focus",
  "evening_reflection",
] as const;

export type AssistantProcessId = (typeof assistantProcessIds)[number];

/** Inline read-only processes that may emit diagnostic evidence without granting a capability. */
export const assistantDiagnosticProcessIds = ["morning_activity_collection", "consent_and_privacy", "day_focus", "evening_reflection"] as const satisfies readonly AssistantProcessId[];
export type AssistantDiagnosticProcessId = (typeof assistantDiagnosticProcessIds)[number];

/**
 * Diagnostic processes a daily schedule may fire. Narrower than the diagnostic
 * set: `consent_and_privacy` emits evidence inside a conversation but is never
 * scheduled, so it has no scheduled prompt.
 */
export const assistantScheduledProcessIds = ["morning_activity_collection", "day_focus", "evening_reflection"] as const satisfies readonly AssistantDiagnosticProcessId[];
export type AssistantScheduledProcessId = (typeof assistantScheduledProcessIds)[number];

export function isAssistantProcessId(value: string): value is AssistantProcessId {
  return (assistantProcessIds as readonly string[]).includes(value);
}

export function isAssistantScheduledProcessId(value: string): value is AssistantScheduledProcessId {
  return (assistantScheduledProcessIds as readonly string[]).includes(value);
}

export function isAssistantDiagnosticProcessId(value: string): value is AssistantDiagnosticProcessId {
  return (assistantDiagnosticProcessIds as readonly string[]).includes(value);
}
