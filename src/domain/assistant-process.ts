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

export function isAssistantProcessId(value: string): value is AssistantProcessId {
  return (assistantProcessIds as readonly string[]).includes(value);
}

export function isAssistantDiagnosticProcessId(value: string): value is AssistantDiagnosticProcessId {
  return (assistantDiagnosticProcessIds as readonly string[]).includes(value);
}
