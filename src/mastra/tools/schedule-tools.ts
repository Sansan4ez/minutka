import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import {
  AssistantScheduleKindChangeError,
  AssistantScheduleNotFoundError,
  AssistantScheduleProcessChangeError,
  UnsupportedAssistantScheduleProcessError,
  type OwnerScheduleCapabilities,
} from "../../application/schedule-management-service.js";
import { assistantScheduledProcessIds, ownerManagedScheduledProcessIds } from "../../domain/assistant-process.js";
import { toScheduleView } from "../../application/schedule-view.js";
import { timezoneSchema } from "../../contracts/minutka-api.js";

export const scheduleViewSchema = z.strictObject({
  id: z.string().min(1),
  kind: z.literal("process"),
  processId: z.enum(assistantScheduledProcessIds),
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
      description: "List the authenticated employee's morning, evening, and weekly message times, including days and next delivery times.",
      strict: true,
      inputSchema: z.strictObject({}),
      outputSchema: scheduleListOutputSchema,
      mcp: { annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
      execute: async () => ({ schedules: (await schedules.listSchedules()).map(toScheduleView) }),
    }),
    setDailySchedule: createTool({
      id: "setDailySchedule",
      description: "Change or re-enable the authenticated employee's morning, evening, or weekly message time. Use the exact processId or scheduleId returned by listSchedules. Timezone defaults to the employee profile.",
      strict: true,
      inputSchema: z.strictObject({
        scheduleId: z.string().min(1).optional(),
        processId: z.enum(ownerManagedScheduledProcessIds).optional(),
        timeOfDay: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u),
        timezone: timezoneSchema.optional(),
        daysOfWeek: z.number().int().min(1).max(127).optional(),
      }),
      outputSchema: scheduleMutationOutputSchema,
      mcp: { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
      execute: async (input) => {
        try {
          return { status: "saved" as const, schedule: toScheduleView(await schedules.saveDailySchedule(input)) };
        } catch (error) {
          if (error instanceof AssistantScheduleNotFoundError) return { status: "not_found" as const };
          if (error instanceof UnsupportedAssistantScheduleProcessError) {
            return { status: "unsupported_process" as const, message: `Можно перенести только утреннее, вечернее или недельное сообщение. Значение ${error.processId || "не указано"} не поддерживается.` };
          }
          if (error instanceof AssistantScheduleKindChangeError) {
            return { status: "unsupported_process" as const, message: "Можно менять только время утреннего, вечернего или недельного сообщения." };
          }
          if (error instanceof AssistantScheduleProcessChangeError) {
            return { status: "unsupported_process" as const, message: "Выбранное расписание относится к другому сообщению. Используйте расписание для нужного утреннего, вечернего или недельного сообщения." };
          }
          throw error;
        }
      },
    }),
    disableSchedule: createTool({
      id: "disableSchedule",
      description: "Disable one authenticated employee's morning, evening, or weekly message by exact id without deleting its delivery history.",
      strict: true,
      inputSchema: z.strictObject({ scheduleId: z.string().min(1) }),
      outputSchema: scheduleMutationOutputSchema,
      mcp: { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
      execute: async ({ scheduleId }) => {
        const visibleSchedule = (await schedules.listSchedules()).find((schedule) => schedule.id === scheduleId);
        if (!visibleSchedule) return { status: "not_found" as const };
        const schedule = await schedules.disableSchedule(scheduleId);
        return schedule ? { status: "disabled" as const, schedule: toScheduleView(schedule) } : { status: "not_found" as const };
      },
    }),
  };
}
