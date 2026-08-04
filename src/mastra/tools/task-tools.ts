import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { AssistantTaskCapabilities } from "../../application/assistant-task-capabilities.js";
import { assistantTaskListMaximumLimit } from "../../application/assistant-task-capabilities.js";
import { pendingTaskReceiptSchema, recordTypeSchema, taskStatusSchema } from "../../contracts/minutka-api.js";

const assistantTaskViewSchema = z.strictObject({
  id: z.string().min(1),
  title: z.string().min(1),
  project: z.string().min(1),
  type: recordTypeSchema,
  status: taskStatusSchema,
  dueDate: z.iso.date().optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  revision: z.number().int().positive(),
});

const taskFilterSchema = z.strictObject({
  project: z.string().min(1).optional(),
  type: recordTypeSchema.optional(),
  status: z.union([taskStatusSchema, z.array(taskStatusSchema).min(1)]).optional(),
  dueBefore: z.iso.date().optional(),
  dueAfter: z.iso.date().optional(),
});

const activeTaskPatchFields = {
  title: z.string().min(1).optional(),
  project: z.string().min(1).optional(),
  type: recordTypeSchema.optional(),
  status: z.enum(["open", "in_progress"]).optional(),
  dueDate: z.iso.date().nullable().optional(),
};

const activeTaskPatchSchema = z.strictObject(activeTaskPatchFields)
  .refine((patch) => Object.keys(patch).length > 0, "Task patch must not be empty");

const taskProposalInputSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("create"), title: z.string().min(1), project: z.string().min(1), type: recordTypeSchema, dueDate: z.iso.date().optional() }),
  z.strictObject({
    kind: z.literal("update"),
    taskId: z.string().min(1),
    expectedRevision: z.number().int().positive().optional(),
    patch: activeTaskPatchSchema,
  }),
  z.strictObject({ kind: z.literal("complete"), taskId: z.string().min(1), expectedRevision: z.number().int().positive().optional() }),
  z.strictObject({ kind: z.literal("cancel"), taskId: z.string().min(1), expectedRevision: z.number().int().positive().optional() }),
]);

// OpenAI Responses rejects the `oneOf` emitted by discriminated unions in
// function parameters. Expose one flat transport object to the provider, then
// enforce the exact operation-specific domain contract before application code.
// Strict provider calls may materialize every optional field as null; preprocess
// keeps the JSON Schema provider-compatible while treating null as omitted.
const providerOptional = <T extends z.ZodType>(schema: T) => z.preprocess(
  (value) => value === null ? undefined : value,
  schema.optional(),
);

const taskProposalTransportSchema = z.strictObject({
  kind: z.enum(["create", "update", "complete", "cancel"]),
  title: providerOptional(z.string().min(1)),
  project: providerOptional(z.string().min(1)),
  type: providerOptional(recordTypeSchema),
  dueDate: providerOptional(z.iso.date()),
  taskId: providerOptional(z.string().min(1)),
  expectedRevision: providerOptional(z.number().int().positive()),
  patch: providerOptional(z.strictObject({
    title: providerOptional(z.string().min(1)),
    project: providerOptional(z.string().min(1)),
    type: providerOptional(recordTypeSchema),
    status: providerOptional(z.enum(["open", "in_progress"])),
    dueDate: providerOptional(z.iso.date()),
    // A nullable date becomes `anyOf` in JSON Schema. The provider transport
    // uses this explicit sentinel while domain validation restores null.
    clearDueDate: providerOptional(z.boolean()),
  })),
});

const invalidTaskProposalSchema = z.strictObject({
  status: z.literal("invalid_request"),
  message: z.string().min(1),
});

const appliedTaskMutationSchema = z.strictObject({
  status: z.literal("applied"),
  actionKind: z.enum(["create", "update", "complete", "idea_to_task"]),
  task: assistantTaskViewSchema,
  undoAvailable: z.literal(true),
});
const taskProposalOutputSchema = z.union([pendingTaskReceiptSchema, appliedTaskMutationSchema, invalidTaskProposalSchema]);

const ideaToTaskProposalSchema = z.union([
  z.strictObject({ status: z.literal("not_found") }),
  z.strictObject({ status: z.literal("already_converted"), taskId: z.string().min(1) }),
  z.strictObject({ status: z.literal("needs_confirmation"), confirmation: pendingTaskReceiptSchema }),
  appliedTaskMutationSchema,
]);

const taskUndoOutputSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("undone"), actionKind: z.enum(["create", "update", "complete", "idea_to_task"]), task: assistantTaskViewSchema, ideaStatusRestored: z.boolean().optional() }),
  z.strictObject({ status: z.literal("already_undone"), actionKind: z.enum(["create", "update", "complete", "idea_to_task"]), task: assistantTaskViewSchema, ideaStatusRestored: z.boolean().optional() }),
  z.strictObject({ status: z.literal("not_found") }),
  z.strictObject({ status: z.literal("expired") }),
  z.strictObject({ status: z.literal("conflict"), actionKind: z.enum(["create", "update", "complete", "idea_to_task"]), current: assistantTaskViewSchema.optional() }),
]);

export const assistantTaskToolNames = ["listTasks", "proposeTaskMutation", "proposeIdeaToTask", "undoTaskMutation"] as const;

export function createTaskTools(tasks: AssistantTaskCapabilities) {
  return {
    listTasks: createTool({
      id: "listTasks",
      description: "List bounded owner tasks. Use this to obtain current task ids and revisions before proposing updates, completion, or cancellation.",
      strict: true,
      inputSchema: z.strictObject({
        filter: taskFilterSchema.optional(),
        limit: z.number().int().min(1).max(assistantTaskListMaximumLimit).optional(),
        order: z.enum(["created_asc", "due_asc"]).optional(),
      }),
      outputSchema: z.strictObject({ tasks: z.array(assistantTaskViewSchema) }),
      mcp: { annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
      execute: async (input) => ({ tasks: await tasks.list(input) }),
    }),
    proposeTaskMutation: createTool({
      id: "proposeTaskMutation",
      description: "Apply one owner-bound create, update, or complete task mutation immediately with a short undo window. Cancellation remains a confirmation proposal. Report applied results in prose, mention that the owner can say 'отмени', and never quote ids or receipts.",
      strict: true,
      inputSchema: taskProposalTransportSchema,
      outputSchema: taskProposalOutputSchema,
      mcp: { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } },
      execute: async (input, context) => {
        const cleaned = withoutNullValues(input);
        const { patch, ...proposal } = cleaned;
        if (patch?.clearDueDate && patch.dueDate !== undefined) {
          return invalidTaskProposal(context, cleaned, "dueDate and clearDueDate are mutually exclusive");
        }
        const normalizedPatch = patch && {
          ...(patch.title === undefined ? {} : { title: patch.title }),
          ...(patch.project === undefined ? {} : { project: patch.project }),
          ...(patch.type === undefined ? {} : { type: patch.type }),
          ...(patch.status === undefined ? {} : { status: patch.status }),
          ...(patch.clearDueDate ? { dueDate: null } : patch.dueDate === undefined ? {} : { dueDate: patch.dueDate }),
        };
        const validation = taskProposalInputSchema.safeParse({
          ...operationFields(proposal),
          ...(normalizedPatch ? { patch: normalizedPatch } : {}),
        });
        if (!validation.success) {
          return invalidTaskProposal(context, cleaned, validation.error.message);
        }
        return tasks.propose(validation.data);
      },
    }),
    proposeIdeaToTask: createTool({
      id: "proposeIdeaToTask",
      description: "Apply one owner-bound conversion of an existing idea into a task immediately with provenance and a short undo window. Report that the task was created, the idea was marked planned and kept in the archive (not deleted), mention that the owner can say 'отмени', and never quote ids.",
      strict: true,
      inputSchema: z.strictObject({ ideaId: z.string().min(1) }),
      outputSchema: ideaToTaskProposalSchema,
      mcp: { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
      execute: ({ ideaId }) => tasks.proposeIdeaToTask(ideaId),
    }),
    undoTaskMutation: createTool({
      id: "undoTaskMutation",
      description: "Undo the owner's most recent reversible task mutation within the short undo window. Use for a plain request such as 'отмени' after creating, updating, completing, or converting an idea to a task.",
      strict: true,
      inputSchema: z.strictObject({}),
      outputSchema: taskUndoOutputSchema,
      mcp: { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
      execute: () => tasks.undoLast(),
    }),
  };
}

function withoutNullValues<T extends Record<string, unknown>>(input: T): T {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== null)) as T;
}

function operationFields(proposal: {
  kind: "create" | "update" | "complete" | "cancel";
  title?: string;
  project?: string;
  type?: z.infer<typeof recordTypeSchema>;
  dueDate?: string;
  taskId?: string;
  expectedRevision?: number;
}): Record<string, unknown> {
  switch (proposal.kind) {
    case "create":
      return {
        kind: proposal.kind,
        ...(proposal.title === undefined ? {} : { title: proposal.title }),
        ...(proposal.project === undefined ? {} : { project: proposal.project }),
        ...(proposal.type === undefined ? {} : { type: proposal.type }),
        ...(proposal.dueDate === undefined ? {} : { dueDate: proposal.dueDate }),
      };
    case "update":
    case "complete":
    case "cancel":
      return {
        kind: proposal.kind,
        ...(proposal.taskId === undefined ? {} : { taskId: proposal.taskId }),
        ...(proposal.expectedRevision === undefined ? {} : { expectedRevision: proposal.expectedRevision }),
      };
  }
}

function invalidTaskProposal(
  context: { observe?: { log(level: "warn", message: string, data?: Record<string, unknown>): void } },
  input: Record<string, unknown>,
  message: string,
): z.infer<typeof invalidTaskProposalSchema> {
  context.observe?.log("warn", "Task proposal validation failed", { input, message });
  return { status: "invalid_request", message: `Task proposal validation failed: ${message}` };
}
