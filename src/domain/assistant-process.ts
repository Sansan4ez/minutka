export const assistantProcessIds = [
  "core",
  "inbox_capture",
  "knowledge_lookup",
  "morning_activity_collection",
  "morning_planning",
  "midday_adjustment",
  "personal_context_review",
  "consent_and_privacy",
  "day_focus",
  "evening_reflection",
] as const;

export type AssistantProcessId = (typeof assistantProcessIds)[number];

/** Active inline processes that may emit diagnostic evidence without granting capability by themselves. */
export const assistantDiagnosticProcessIds = ["morning_planning", "midday_adjustment", "personal_context_review", "consent_and_privacy", "evening_reflection"] as const satisfies readonly AssistantProcessId[];
export type AssistantDiagnosticProcessId = (typeof assistantDiagnosticProcessIds)[number];

/**
 * Diagnostic processes a daily schedule may fire. Narrower than the diagnostic
 * set: `consent_and_privacy` emits evidence inside a conversation but is never
 * scheduled, so it has no scheduled prompt.
 */
export const assistantScheduledProcessIds = ["morning_planning", "evening_reflection"] as const satisfies readonly AssistantDiagnosticProcessId[];
export type AssistantScheduledProcessId = (typeof assistantScheduledProcessIds)[number];

/**
 * Processes outside the «Минутка» product boundary. Mirrors
 * `vault/assistant/processes/disabled-registry.json`: their manuals stay out of
 * the prompt and their tools stay out of the agent toolset.
 */
export const assistantDisabledProcessIds = ["inbox_capture", "knowledge_lookup", "morning_activity_collection", "day_focus"] as const satisfies readonly AssistantProcessId[];
export type AssistantDisabledProcessId = (typeof assistantDisabledProcessIds)[number];

/**
 * Owning process of an inherited assistant tool. A tool without an entry serves
 * no single process and stays inside the product boundary.
 */
export const assistantToolProcessOwners: Readonly<Record<string, AssistantProcessId | undefined>> = {
  captureIdea: "inbox_capture",
  searchIdeas: "inbox_capture",
  appendIdea: "inbox_capture",
  proposeIdeaDeletion: "inbox_capture",
  undoIdeaDeletion: "inbox_capture",
  listTasks: "day_focus",
  proposeTaskMutation: "day_focus",
  proposeIdeaToTask: "day_focus",
  undoTaskMutation: "day_focus",
  listProjects: "inbox_capture",
  listDocuments: "knowledge_lookup",
  readDocument: "knowledge_lookup",
  searchDocuments: "knowledge_lookup",
  createContextNote: "knowledge_lookup",
  proposeContextDocumentUpdate: "knowledge_lookup",
  proposeContextDocumentMove: "knowledge_lookup",
  proposeContextDocumentDelete: "knowledge_lookup",
  updatePersonalContext: undefined,
};

export function isAssistantProcessId(value: string): value is AssistantProcessId {
  return (assistantProcessIds as readonly string[]).includes(value);
}

export function isAssistantDisabledProcessId(value: string): value is AssistantDisabledProcessId {
  return (assistantDisabledProcessIds as readonly string[]).includes(value);
}

/** True for a tool the «Минутка» agent must never be offered. */
export function isAssistantDisabledToolName(toolName: string): boolean {
  const owner = assistantToolProcessOwners[toolName];
  return owner !== undefined && isAssistantDisabledProcessId(owner);
}

export function isAssistantScheduledProcessId(value: string): value is AssistantScheduledProcessId {
  return (assistantScheduledProcessIds as readonly string[]).includes(value);
}

export function isAssistantDiagnosticProcessId(value: string): value is AssistantDiagnosticProcessId {
  return (assistantDiagnosticProcessIds as readonly string[]).includes(value);
}
