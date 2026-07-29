import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { assistantDiagnosticProcessIds, type AssistantDiagnosticProcessId } from "../../domain/assistant-process.js";

export const markProcessUsedToolName = "markProcessUsed" as const;
export const assistantDiagnosticProcessIdSchema = z.enum(assistantDiagnosticProcessIds);

/**
 * Request-scoped diagnostic marker. It records that an inline process was
 * actually applied, but exposes no storage, authority, or business action.
 */
export function createMarkProcessUsedTool(markProcessUsed: (id: AssistantDiagnosticProcessId) => void) {
  return createTool({
    id: markProcessUsedToolName,
    description: "Record diagnostic evidence that an allow-listed inline read-only process was applied. This grants no capability and performs no business action.",
    strict: true,
    inputSchema: z.strictObject({ id: assistantDiagnosticProcessIdSchema }),
    outputSchema: z.strictObject({ recorded: z.literal(true), id: assistantDiagnosticProcessIdSchema }),
    mcp: { annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
    execute: async ({ id }) => {
      markProcessUsed(id);
      return { recorded: true as const, id };
    },
  });
}
