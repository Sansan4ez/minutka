import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { retrospectiveUpdateSchema, type WorkRetrospectiveCapabilities } from "../../application/work-retrospective-request.js";

export const workRetrospectiveToolNames = ["readWorkRetrospective", "updateWorkRetrospective"] as const;
export function createWorkRetrospectiveTools(capabilities: WorkRetrospectiveCapabilities) {
  return {
    readWorkRetrospective: createTool({ id: "readWorkRetrospective", description: "Read the current request-bound durable episode and consented follow-up. No identity or target arguments.", inputSchema: z.strictObject({}), execute: async () => capabilities.read() }),
    updateWorkRetrospective: createTool({ id: "updateWorkRetrospective", description: "Stage the bound episode question, closure or explicit employee consent for canonical response persistence. Include the exact question text in your final answer. Never promise persistence or follow-up from a staged outcome.", inputSchema: retrospectiveUpdateSchema, execute: async (input) => capabilities.update(input) }),
  };
}
