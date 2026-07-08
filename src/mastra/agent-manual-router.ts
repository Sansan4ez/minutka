import { createIndexFirstAgentManualRouter } from "../application/agent-manual-resolver.js";
import type { AgentManualRouter } from "../application/agent-manual-resolver.js";
import { agentManualRouterAgent } from "./agents/agent-manual-router-agent.js";

export const routeAgentManualProcesses: AgentManualRouter =
  createIndexFirstAgentManualRouter(async (prompt) => {
    const result = await agentManualRouterAgent.generate(prompt);
    return result.text ?? "";
  });
