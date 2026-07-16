import type { DecisionProcessId } from "../domain/conversation-decision.js";

export type AgentManualProcessId = DecisionProcessId;

export type AgentManualPurpose =
  | "chat"
  | "onboarding_first_response"
  | "feedback"
  | "inbound_record";

export type AgentManualProcess = {
  id: Exclude<AgentManualProcessId, "core">;
  path: string;
  content: string;
  appliesTo?: AgentManualPurpose[];
  dependencies: string[];
};

export type AgentManual = {
  version: number;
  manualId: string;
  core: { id: "core"; path: string; content: string };
  runtimeDocs: Array<{ id: string; path: string; content: string }>;
  processIndex?: { path: string; content: string };
  processes: AgentManualProcess[];
};

export type AgentManualSelection = {
  selectedProcessIds: AgentManualProcessId[];
  manualContext: string;
};

export type AgentManualValidationResult = {
  ok: boolean;
  errors: string[];
  warnings: string[];
};

export type AgentManualLoader = {
  load(): AgentManual;
  validate?(manual: AgentManual): AgentManualValidationResult;
};

export const agentManualProcessIds = [
  "core",
  "onboarding",
  "consent_and_privacy",
  "evening_reflection",
  "workday_guardrails",
  "insight_extraction",
  "feedback",
  "inbox_capture",
] as const satisfies readonly AgentManualProcessId[];

export const requiredAgentManualProcessIds = [
  "onboarding",
  "consent_and_privacy",
  "evening_reflection",
  "workday_guardrails",
  "insight_extraction",
  "feedback",
  "inbox_capture",
] as const satisfies readonly Exclude<AgentManualProcessId, "core">[];

export const requiredProcessSections = [
  "## When this process applies",
  "## Inputs",
  "## Process",
  "## Outputs",
  "## Privacy notes",
  "## Anti-patterns",
  "## Dependencies",
] as const;
