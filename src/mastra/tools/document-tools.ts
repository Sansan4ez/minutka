import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { createOwnerDocumentReader } from "../../application/document-reader.js";

const documentPathSchema = z.string().startsWith("/proc/context/");
const metadataSchema = z.strictObject({
  path: documentPathSchema,
  version: z.string(),
  updatedAt: z.string(),
  characters: z.number().int().nonnegative(),
});

export const assistantDocumentToolNames = ["listDocuments", "readDocument", "searchDocuments"] as const;

export function createDocumentTools(reader: ReturnType<typeof createOwnerDocumentReader>) {
  return {
    listDocuments: createTool({
      id: "listDocuments",
      description: "List owner documents under /proc/context with bounded metadata and cursor pagination.",
      strict: true,
      inputSchema: z.strictObject({
        prefix: z.string().optional(),
        cursor: documentPathSchema.optional(),
        limit: z.number().int().min(1).max(50).optional(),
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
      description: "Read a bounded range or exact Markdown section from one owner document under /proc/context.",
      strict: true,
      inputSchema: z.strictObject({
        path: documentPathSchema,
        offset: z.number().int().nonnegative().optional(),
        section: z.string().min(1).optional(),
        maxCharacters: z.number().int().min(1).max(8_000).optional(),
      }),
      outputSchema: z.strictObject({
        path: documentPathSchema,
        found: z.boolean(),
        sectionFound: z.boolean(),
        content: z.string(),
        offset: z.number().int().nonnegative(),
        nextOffset: z.number().int().nonnegative().nullable(),
        truncated: z.boolean(),
        version: z.string(),
        updatedAt: z.string(),
      }),
      mcp: { annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
      execute: (input) => reader.readDocument(input),
    }),
    searchDocuments: createTool({
      id: "searchDocuments",
      description: "Search owner document paths and contents under /proc/context and return bounded snippets.",
      strict: true,
      inputSchema: z.strictObject({
        query: z.string().min(2),
        prefix: z.string().optional(),
        limit: z.number().int().min(1).max(20).optional(),
      }),
      outputSchema: z.strictObject({
        matches: z.array(z.strictObject({
          path: documentPathSchema,
          snippet: z.string().max(502),
          version: z.string(),
          updatedAt: z.string(),
        })),
        truncated: z.boolean(),
      }),
      mcp: { annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
      execute: (input) => reader.searchDocuments(input),
    }),
  };
}
