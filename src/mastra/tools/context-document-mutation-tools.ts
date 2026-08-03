import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import {
  assistantWritableContextSections,
  type AssistantContextDocumentCapabilities,
} from "../../application/assistant-context-document-capabilities.js";

const contextDocumentHandleSchema = z.string().startsWith("/proc/context/").endsWith(".md");
const versionSchema = z.string().min(1).max(512);
const providerOptional = <T extends z.ZodType>(schema: T) => z.preprocess(
  (value) => value === null ? undefined : value,
  schema.optional(),
);
const createOutcomeSchema = z.discriminatedUnion("outcome", [
  z.strictObject({ outcome: z.literal("created"), path: contextDocumentHandleSchema, version: z.string().min(1) }),
  z.strictObject({ outcome: z.literal("conflict"), path: contextDocumentHandleSchema, currentVersion: z.string().min(1) }),
]);
const safeConfirmationSchema = z.strictObject({
  confirmationId: z.string().min(1),
  actionKind: z.enum(["update", "move", "delete"]),
  summary: z.string().min(1),
  expiresAt: z.iso.datetime(),
});
const proposalOutcomeSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("needs_confirmation"), confirmation: safeConfirmationSchema }),
  z.strictObject({ status: z.literal("not_found") }),
  z.strictObject({ status: z.enum(["conflict", "destination_conflict"]), currentVersion: z.string().min(1) }),
]);

export const assistantContextDocumentMutationToolNames = [
  "createContextNote",
  "proposeContextDocumentUpdate",
  "proposeContextDocumentMove",
  "proposeContextDocumentDelete",
] as const;

export function createContextDocumentMutationTools(documents: AssistantContextDocumentCapabilities) {
  return {
    createContextNote: createTool({
      id: "createContextNote",
      description: "Create a new owner Markdown note only after an explicit request to save or add it. Returns the safe /proc/context path and version; never accepts owner or physical storage identifiers.",
      strict: true,
      inputSchema: z.strictObject({
        title: z.string().min(1),
        content: z.string().min(1),
        destination: providerOptional(z.enum(assistantWritableContextSections)),
      }),
      outputSchema: createOutcomeSchema,
      mcp: { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } },
      execute: (input) => documents.createNote(withoutNullValues(input)),
    }),
    proposeContextDocumentUpdate: createTool({
      id: "proposeContextDocumentUpdate",
      description: "Prepare one owner-bound Markdown update after readDocument supplied the current version. Never mutates before authenticated confirmation and must not be retried automatically after a version conflict.",
      strict: true,
      inputSchema: z.strictObject({
        path: contextDocumentHandleSchema,
        expectedVersion: versionSchema,
        replacement: providerOptional(z.string().min(1)),
        patchSearch: providerOptional(z.string().min(1)),
        patchReplacement: providerOptional(z.string()),
      }),
      outputSchema: proposalOutcomeSchema,
      mcp: { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } },
      execute: (input) => {
        const cleaned = withoutNullValues(input);
        const hasReplacement = cleaned.replacement !== undefined;
        const hasPatch = cleaned.patchSearch !== undefined || cleaned.patchReplacement !== undefined;
        if (hasReplacement === hasPatch || (hasPatch && cleaned.patchSearch === undefined)) {
          throw new Error("provide exactly one replacement or complete patch");
        }
        return documents.proposeUpdate({
          path: cleaned.path,
          expectedVersion: cleaned.expectedVersion,
          ...(hasReplacement
            ? { replacement: cleaned.replacement }
            : { patch: { search: cleaned.patchSearch!, replacement: cleaned.patchReplacement ?? "" } }),
        });
      },
    }),
    proposeContextDocumentMove: createTool({
      id: "proposeContextDocumentMove",
      description: "Prepare one owner-bound Markdown move/rename using the version returned by readDocument. Never mutates before authenticated confirmation.",
      strict: true,
      inputSchema: z.strictObject({
        path: contextDocumentHandleSchema,
        destination: contextDocumentHandleSchema,
        expectedVersion: versionSchema,
      }),
      outputSchema: proposalOutcomeSchema,
      mcp: { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } },
      execute: (input) => documents.proposeMove(input),
    }),
    proposeContextDocumentDelete: createTool({
      id: "proposeContextDocumentDelete",
      description: "Prepare one owner-bound Markdown deletion using the version returned by readDocument. Never mutates before authenticated confirmation.",
      strict: true,
      inputSchema: z.strictObject({ path: contextDocumentHandleSchema, expectedVersion: versionSchema }),
      outputSchema: proposalOutcomeSchema,
      mcp: { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } },
      execute: (input) => documents.proposeDelete(input),
    }),
  };
}

function withoutNullValues<T extends Record<string, unknown>>(input: T): T {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== null)) as T;
}
