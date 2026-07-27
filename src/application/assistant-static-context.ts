export function renderAssistantBaseInstructions(): string {
  return "# Personal assistant runtime context";
}

export function renderAssistantAgentManual(agentInstructions: string, responsePolicy?: string): string {
  return [agentInstructions, responsePolicy].filter(Boolean).join("\n\n");
}
