import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { activityTransactionModes, type ActivityTransactionMode } from "../../application/activity-transaction-extractor.js";
import type { ActivityTransactionServiceResult } from "../../application/activity-transaction-service.js";

export const processCurrentActivityTurnToolName = "processCurrentActivityTurn" as const;

const processCurrentActivityTurnInputSchema = z.strictObject({
  mode: z.enum(activityTransactionModes).describe(
    "record for explicitly completed or in-progress work; repair only for an explicit correction, clarification, or confirmed duplicate",
  ),
});

export type ProcessCurrentActivityTurnResult =
  | { status: "no_write"; reason: "no_factual_activity" }
  | { status: "needs_clarification"; reason: "activity_status_ambiguous" | "correction_target_ambiguous" | "duplicate_pair_ambiguous" | "repair_target_not_found" }
  | { status: "completed"; operation: "collect"; savedCount: number }
  | { status: "completed"; operation: "correct" | "supersede"; revision: number }
  | { status: "partial"; operation: "collect"; savedCount: number; code: "validation_error" | "persistence_conflict" | "persistence_unavailable" | "persistence_error" }
  | { status: "failed"; phase: "validation" | "extract" | "read" | "write"; code: "context_budget_error" | "provider_error" | "schema_error" | "validation_error" | "persistence_conflict" | "persistence_unavailable" | "persistence_error" }
  | { status: "outcome_unknown"; phase: "write" };

/**
 * Broad-agent activity boundary: the model chooses only the coarse semantic
 * mode. Current text, authenticated identity, tenant scope, duration evidence,
 * candidates, handles, revisions, and closed facets stay inside application
 * wiring and the bounded transaction service.
 */
export function createProcessCurrentActivityTurnTool(
  processCurrentActivityTurn: (input: { mode: ActivityTransactionMode }) => Promise<ActivityTransactionServiceResult>,
) {
  return createTool({
    id: processCurrentActivityTurnToolName,
    description: "Process factual work from the current authenticated employee turn. Use mode=record for completed or in-progress work, including repeated real work. Use mode=repair only for an explicit correction/clarification of a recent activity or an explicitly confirmed duplicate. Do not call for plans, intentions, future work, weekly/cycle reads, or a scheduled invitation without a fresh employee account. The application binds the current text and all authority; wait for this typed result before saying anything was recorded, corrected, or removed from summaries.",
    strict: true,
    inputSchema: processCurrentActivityTurnInputSchema,
    mcp: { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } },
    execute: async ({ mode }) => compactActivityTransactionResult(await processCurrentActivityTurn({ mode })),
  });
}

function compactActivityTransactionResult(result: ActivityTransactionServiceResult): ProcessCurrentActivityTurnResult {
  switch (result.status) {
    case "no_write":
      return { status: "no_write", reason: result.reason };
    case "needs_clarification":
      return { status: "needs_clarification", reason: result.reason };
    case "completed":
      return result.operation === "collect"
        ? { status: "completed", operation: "collect", savedCount: result.savedCount }
        : { status: "completed", operation: result.operation, revision: result.revision };
    case "partial":
      return { status: "partial", operation: "collect", savedCount: result.savedCount, code: result.code };
    case "failed":
      return { status: "failed", phase: result.phase, code: result.code };
    case "outcome_unknown":
      return { status: "outcome_unknown", phase: "write" };
  }
}
