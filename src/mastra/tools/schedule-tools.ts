import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import {
  AssistantScheduleKindChangeError,
  AssistantScheduleNotFoundError,
  UnsupportedAssistantScheduleProcessError,
  type OwnerScheduleCapabilities,
} from "../../application/schedule-management-service.js";
import { assistantDiagnosticProcessIds } from "../../domain/assistant-process.js";
import { toScheduleView } from "../../application/schedule-view.js";
import { timezoneSchema } from "../../contracts/minutka-api.js";

export const scheduleViewSchema = z.strictObject({
  id: z.string().min(1),
  kind: z.enum(["process", "reminder"]),
  processId: z.enum(assistantDiagnosticProcessIds).optional(),
  reminderText: z.string().min(1).max(512).optional(),
  daysOfWeek: z.number().int().min(1).max(127),
  oneShot: z.boolean(),
  timeOfDay: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u),
  timezone: timezoneSchema,
  enabled: z.boolean(),
  nextFireAt: z.iso.datetime(),
});

export const scheduleMutationOutputSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("saved"), schedule: scheduleViewSchema }),
  z.strictObject({ status: z.literal("disabled"), schedule: scheduleViewSchema }),
  z.strictObject({ status: z.literal("not_found") }),
  z.strictObject({ status: z.literal("unsupported_process"), message: z.string().min(1) }),
]);

export const scheduleListOutputSchema = z.strictObject({ schedules: z.array(scheduleViewSchema) });

export const assistantScheduleToolNames = ["listSchedules", "setDailySchedule", "disableSchedule"] as const;

export function createScheduleTools(schedules: OwnerScheduleCapabilities) {
  return {
    listSchedules: createTool({
      id: "listSchedules",
      description: "List the authenticated owner's process and reminder schedules, including days and next fire times.",
      strict: true,
      inputSchema: z.strictObject({}),
      outputSchema: scheduleListOutputSchema,
      mcp: { annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
      execute: async () => ({ schedules: (await schedules.listSchedules()).map(toScheduleView) }),
    }),
    setDailySchedule: createTool({
      id: "setDailySchedule",
      description: "Create, change, or re-enable a process or reminder schedule. For kind=reminder provide reminderText; oneShot uses the nearest future occurrence of HH:mm. Timezone defaults to the owner profile.",
      strict: true,
      inputSchema: z.strictObject({
        scheduleId: z.string().min(1).optional(),
        kind: z.enum(["process", "reminder"]).optional(),
        processId: z.string().min(1).optional(),
        reminderText: z.string().min(1).max(512).optional(),
        timeOfDay: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u),
        timezone: timezoneSchema.optional(),
        daysOfWeek: z.number().int().min(1).max(127).optional(),
        oneShot: z.boolean().optional(),
      }),
      outputSchema: scheduleMutationOutputSchema,
      mcp: { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
      execute: async (input) => {
        try {
          return { status: "saved" as const, schedule: toScheduleView(await schedules.saveDailySchedule(input)) };
        } catch (error) {
          if (error instanceof AssistantScheduleNotFoundError) return { status: "not_found" as const };
          if (error instanceof UnsupportedAssistantScheduleProcessError) {
            return { status: "unsupported_process" as const, message: `Процесс ${error.processId || "не указан"} нельзя добавить в расписание. Доступны процессы ${assistantDiagnosticProcessIds.join(", ")} или kind=reminder с reminderText.` };
          }
          if (error instanceof AssistantScheduleKindChangeError) {
            return { status: "unsupported_process" as const, message: "Нельзя сменить вид расписания. Отключите старое расписание и создайте новое." };
          }
          throw error;
        }
      },
    }),
    disableSchedule: createTool({
      id: "disableSchedule",
      description: "Disable one authenticated owner schedule by exact id without deleting its fire history.",
      strict: true,
      inputSchema: z.strictObject({ scheduleId: z.string().min(1) }),
      outputSchema: scheduleMutationOutputSchema,
      mcp: { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
      execute: async ({ scheduleId }) => {
        const schedule = await schedules.disableSchedule(scheduleId);
        return schedule ? { status: "disabled" as const, schedule: toScheduleView(schedule) } : { status: "not_found" as const };
      },
    }),
  };
}
