import type { MinutkaServiceDeps } from "../application/minutka-service.js";
import { routeAgentManualProcesses } from "./agent-manual-router.js";

export function createMastraMinutkaServiceDeps(
  overrides: MinutkaServiceDeps = {},
): MinutkaServiceDeps {
  return {
    agentManualRouter: routeAgentManualProcesses,
    ...overrides,
  };
}
