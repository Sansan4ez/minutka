import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { createOwnerDocumentReader } from "../../application/document-reader.js";

const documentPathSchema = z.string().startsWith("/proc/context/");
const metadataSchema = z.strictObject({
  path: documentPathSchema,
  version: z.string(),
  updatedAt: z.string(),
  size: z.number().int().nonnegative(),
});

export const assistantDocumentToolNames = ["listDocuments", "readDocument", "searchDocuments"] as const;

export function createDocumentTools(reader: ReturnType<typeof createOwnerDocumentReader>) {
  const searchSnippetMaximum = reader.limits.searchSnippetCharacters + 2;
  const searchSnippetSchema = z.string().refine(
    (snippet) => Array.from(snippet).length <= searchSnippetMaximum,
    { message: `snippet must contain at most ${searchSnippetMaximum} Unicode characters` },
  );

  return {
    listDocuments: createTool({
      id: "listDocuments",
      description: "List owner documents under /proc/context with bounded metadata and cursor pagination.",
      strict: true,
      inputSchema: z.strictObject({
        prefix: z.string().optional(),
        cursor: documentPathSchema.optional(),
        limit: z.number().int().min(1).max(reader.limits.listMaximum).optional(),
      }),
      outputSchema: z.strictObject({
        documents: z.array(metadataSchema),
        nextCursor: documentPathSchema.nullable(),
        truncated: z.boolean(),
      }),
      mcp: { annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
      execute: (input) => reader.listDocuments(input),
    }),
    readDocument: createTool({
      id: "readDocument",
      description: "Read a bounded range or exact Markdown section under /proc/context, subject to per-turn output-character, physical-scan-byte, and per-document-byte limits.",
      strict: true,
      inputSchema: z.strictObject({
        path: documentPathSchema,
        offset: z.number().int().nonnegative().optional(),
        section: z.string().min(1).optional(),
        maxCharacters: z.number().int().min(1).max(reader.limits.readMaximumCharacters).optional(),
      }),
      outputSchema: z.strictObject({
        path: documentPathSchema,
        found: z.boolean(),
        sectionFound: z.boolean(),
        content: z.string(),
        offset: z.number().int().nonnegative(),
        totalCharacters: z.number().int().nonnegative().nullable(),
        nextOffset: z.number().int().nonnegative().nullable(),
        truncated: z.boolean(),
        readBudgetExhausted: z.boolean(),
        scanBudgetExhausted: z.boolean(),
        documentTooLarge: z.boolean(),
        hint: z.string().nullable(),
        version: z.string(),
        updatedAt: z.string(),
      }),
      mcp: { annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
      execute: (input) => reader.readDocument(input),
    }),
    searchDocuments: createTool({
      id: "searchDocuments",
      description: "Search owner document paths and contents under /proc/context, returning bounded snippets until output-character or physical-scan-byte limits are exhausted.",
      strict: true,
      inputSchema: z.strictObject({
        query: z.string().min(2),
        prefix: z.string().optional(),
        limit: z.number().int().min(1).max(reader.limits.searchMaximum).optional(),
      }),
      outputSchema: z.strictObject({
        matches: z.array(z.strictObject({
          path: documentPathSchema,
          snippet: searchSnippetSchema,
          version: z.string(),
          updatedAt: z.string(),
        })),
        truncated: z.boolean(),
        readBudgetExhausted: z.boolean(),
        scanBudgetExhausted: z.boolean(),
        documentTooLarge: z.boolean(),
        hint: z.string().nullable(),
      }),
      mcp: { annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
      execute: (input) => reader.searchDocuments(input),
    }),
  };
}
