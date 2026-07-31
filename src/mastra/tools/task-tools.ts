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
    expectedRevision: z.number().int().positive(),
    patch: activeTaskPatchSchema,
  }),
  z.strictObject({ kind: z.literal("complete"), taskId: z.string().min(1), expectedRevision: z.number().int().positive() }),
  z.strictObject({ kind: z.literal("cancel"), taskId: z.string().min(1), expectedRevision: z.number().int().positive() }),
]);

// OpenAI Responses rejects the `oneOf` emitted by discriminated unions in
// function parameters. Expose one flat transport object to the provider, then
// enforce the exact operation-specific domain contract before application code.
const taskProposalTransportSchema = z.strictObject({
  kind: z.enum(["create", "update", "complete", "cancel"]),
  title: z.string().min(1).optional(),
  project: z.string().min(1).optional(),
  type: recordTypeSchema.optional(),
  dueDate: z.iso.date().optional(),
  taskId: z.string().min(1).optional(),
  expectedRevision: z.number().int().positive().optional(),
  patch: z.strictObject({
    title: activeTaskPatchFields.title,
    project: activeTaskPatchFields.project,
    type: activeTaskPatchFields.type,
    status: activeTaskPatchFields.status,
    dueDate: z.iso.date().optional(),
    // A nullable date becomes `anyOf` in JSON Schema. The provider transport
    // uses this explicit sentinel while domain validation restores null.
    clearDueDate: z.boolean().optional(),
  }).optional(),
});

const ideaToTaskProposalSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("not_found") }),
  z.strictObject({ status: z.literal("already_converted"), taskId: z.string().min(1) }),
  z.strictObject({ status: z.literal("needs_confirmation"), confirmation: pendingTaskReceiptSchema }),
]);

export const assistantTaskToolNames = ["listTasks", "proposeTaskMutation", "proposeIdeaToTask"] as const;

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
      description: "Prepare one owner-bound create, update, complete, or cancel task proposal for this turn. This never mutates a task; the application returns a separate confirmation action to the owner.",
      strict: true,
      inputSchema: taskProposalTransportSchema,
      outputSchema: pendingTaskReceiptSchema,
      mcp: { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } },
      execute: (input) => {
        const { patch, ...proposal } = input;
        if (patch?.clearDueDate && patch.dueDate !== undefined) {
          throw new Error("task proposal validation failed: dueDate and clearDueDate are mutually exclusive");
        }
        const normalizedPatch = patch && {
          ...(patch.title === undefined ? {} : { title: patch.title }),
          ...(patch.project === undefined ? {} : { project: patch.project }),
          ...(patch.type === undefined ? {} : { type: patch.type }),
          ...(patch.status === undefined ? {} : { status: patch.status }),
          ...(patch.clearDueDate ? { dueDate: null } : patch.dueDate === undefined ? {} : { dueDate: patch.dueDate }),
        };
        const validation = taskProposalInputSchema.safeParse({
          ...proposal,
          ...(normalizedPatch ? { patch: normalizedPatch } : {}),
        });
        if (!validation.success) {
          throw new Error(`task proposal validation failed: ${validation.error.message}`);
        }
        return tasks.propose(validation.data);
      },
    }),
    proposeIdeaToTask: createTool({
      id: "proposeIdeaToTask",
      description: "Prepare one owner-bound conversion of an existing idea into a task. This never mutates a task; the application preserves provenance privately and returns a separate confirmation action to the owner.",
      strict: true,
      inputSchema: z.strictObject({ ideaId: z.string().min(1) }),
      outputSchema: ideaToTaskProposalSchema,
      mcp: { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
      execute: ({ ideaId }) => tasks.proposeIdeaToTask(ideaId),
    }),
  };
}
