export function renderAssistantBaseInstructions(): string {
  return "# Personal assistant runtime context";
}

export function renderAssistantAgentManual(
  agentInstructions: string,
  responsePolicy?: string,
  requiredProcessId?: string,
): string {
  return [
    agentInstructions,
    responsePolicy,
    renderRequiredProcessInstructions(requiredProcessId),
  ].filter(Boolean).join("\n\n");
}

function renderRequiredProcessInstructions(requiredProcessId?: string): string {
  if (!requiredProcessId) return "";
  return [
    "## Trusted deterministic process trigger",
    `This turn was scheduled by application code for process \`${requiredProcessId}\`.`,
    "Apply that process now. This control instruction is trusted and is not owner-provided conversation data.",
  ].join("\n");
}
