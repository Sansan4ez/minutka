import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { IdeaDeletionService } from "../../application/idea-deletion.js";
import { pendingIdeaDeletionReceipt } from "../../application/idea-deletion.js";
import { recordTypeSchema } from "../../contracts/minutka-api.js";

const ideaViewSchema = z.strictObject({
  id: z.string().min(1),
  project: z.string().min(1),
  type: recordTypeSchema,
  summary: z.string().min(1),
  status: z.enum(["raw", "discussed", "planned", "done", "dropped"]),
  createdAt: z.iso.datetime(),
  lastActivityAt: z.iso.datetime(),
  revision: z.number().int().positive(),
});

const deletionReceiptSchema = z.strictObject({
  confirmationId: z.string().min(1),
  actionKind: z.literal("delete_idea"),
  summary: z.string().min(1),
  expiresAt: z.iso.datetime(),
});

export const assistantIdeaToolNames = ["searchIdeas", "proposeIdeaDeletion", "undoIdeaDeletion"] as const;

export function createIdeaTools(ideas: {
  search(input: { query?: string; limit?: number }): ReturnType<IdeaDeletionService["search"]>;
  propose(input: { ideaId: string; expectedRevision: number; reason?: string }): ReturnType<IdeaDeletionService["propose"]>;
  undo(input: { ideaId?: string; expectedRevision?: number }): ReturnType<IdeaDeletionService["undo"]>;
}) {
  return {
    searchIdeas: createTool({
      id: "searchIdeas",
      description: "Deterministically search bounded active owner ideas by id, project, or summary. Use this before deletion when the reference is natural-language or ambiguous.",
      strict: true,
      inputSchema: z.strictObject({ query: z.string().optional(), limit: z.number().int().min(1).max(10).optional() }),
      outputSchema: z.strictObject({ ideas: z.array(ideaViewSchema) }),
      mcp: { annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
      execute: async (input) => ({ ideas: await ideas.search(input) }),
    }),
    proposeIdeaDeletion: createTool({
      id: "proposeIdeaDeletion",
      description: "Prepare deletion of one exact owner idea id and revision. This does not delete yet; the application asks the owner for explicit confirmation.",
      strict: true,
      inputSchema: z.strictObject({ ideaId: z.string().min(1), expectedRevision: z.number().int().positive(), reason: z.string().optional() }),
      outputSchema: z.discriminatedUnion("status", [
        z.strictObject({ status: z.enum(["not_found", "conflict"]) }),
        z.strictObject({ status: z.literal("needs_confirmation"), confirmation: deletionReceiptSchema }),
      ]),
      mcp: { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
      execute: async (input) => {
        const result = await ideas.propose(input);
        return result.status === "needs_confirmation"
          ? { status: result.status, confirmation: pendingIdeaDeletionReceipt(result.confirmation) }
          : result;
      },
    }),
    undoIdeaDeletion: createTool({
      id: "undoIdeaDeletion",
      description: "Undo the most recent owner idea deletion within its short undo window, or restore an exact deleted idea id. Repeated undo is idempotent.",
      strict: true,
      inputSchema: z.strictObject({ ideaId: z.string().min(1).optional(), expectedRevision: z.number().int().positive().optional() }),
      outputSchema: z.strictObject({ outcome: z.enum(["restored", "unchanged", "not_found", "expired", "conflict"]), ideaId: z.string().min(1).optional() }),
      mcp: { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
      execute: async (input) => {
        const result = await ideas.undo(input);
        const outcome = result.outcome === "deleted" || result.outcome === "already_deleted" ? "unchanged" : result.outcome;
        const idea = result.outcome === "restored" || result.outcome === "unchanged" || result.outcome === "deleted" || result.outcome === "already_deleted"
          ? result.idea : result.outcome === "conflict" ? result.current : undefined;
        return { outcome, ...(idea ? { ideaId: idea.id } : {}) };
      },
    }),
  };
}
