export const assistantProcessIds = [
  "core",
  "inbox_capture",
  "day_focus",
] as const;

export type AssistantProcessId = (typeof assistantProcessIds)[number];

/** Inline read-only processes that may emit diagnostic evidence without granting a capability. */
export const assistantDiagnosticProcessIds = ["day_focus"] as const satisfies readonly AssistantProcessId[];
export type AssistantDiagnosticProcessId = (typeof assistantDiagnosticProcessIds)[number];

export function isAssistantProcessId(value: string): value is AssistantProcessId {
  return (assistantProcessIds as readonly string[]).includes(value);
}

export function isAssistantDiagnosticProcessId(value: string): value is AssistantDiagnosticProcessId {
  return (assistantDiagnosticProcessIds as readonly string[]).includes(value);
}
