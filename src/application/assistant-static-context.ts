export function renderAssistantBaseInstructions(requiredProcessId?: string): string {
  return [
    "# Personal assistant runtime context",
    ...(requiredProcessId ? [
      "",
      "## Trusted deterministic process trigger",
      `This turn was scheduled by application code for process \`${requiredProcessId}\`.`,
      "Apply that process now. This control instruction is trusted and is not owner-provided conversation data.",
    ] : []),
  ].join("\n");
}

export function renderAssistantAgentManual(agentInstructions: string, responsePolicy?: string): string {
  return [agentInstructions, responsePolicy].filter(Boolean).join("\n\n");
}
