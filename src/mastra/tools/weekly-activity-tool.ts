import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import {
  activityDurationBuckets,
  activitySystems,
  automationCandidateTypes,
  energyStressMarkerTypes,
  routinePatternTypes,
  taskCategories,
} from "../../domain/insights.js";
import type { WeeklyActivitySummary } from "../../application/weekly-activity-summary.js";

export const readWeeklyActivitiesToolName = "readWeeklyActivities" as const;

const tallySchema = <Values extends readonly [string, ...string[]]>(values: Values) =>
  z.array(z.strictObject({ value: z.enum(values), count: z.number().int().min(1) }));

export const weeklyActivitySummarySchema = z.strictObject({
  fromDate: z.string(),
  toDate: z.string(),
  activityCount: z.number().int().min(0),
  activeDates: z.number().int().min(0),
  sufficientData: z.boolean(),
  taskCategories: tallySchema(taskCategories),
  routinePatterns: tallySchema(routinePatternTypes),
  automationCandidates: tallySchema(automationCandidateTypes),
  energyStressMarkers: tallySchema(energyStressMarkerTypes),
  durationBuckets: tallySchema(activityDurationBuckets),
  systems: tallySchema(activitySystems),
});

/** Reads the authenticated employee's own counted week; it records nothing. */
export function createReadWeeklyActivitiesTool(readWeeklyActivities: () => Promise<WeeklyActivitySummary>) {
  return createTool({
    id: readWeeklyActivitiesToolName,
    description: "Read counted structured activities the authenticated employee reported over the last seven days. Counts come from the application, not from the model: name only what this result contains, and when sufficientData is false say the week is too thin instead of describing a pattern.",
    strict: true,
    inputSchema: z.strictObject({}),
    outputSchema: weeklyActivitySummarySchema,
    mcp: { annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
    execute: async () => readWeeklyActivities(),
  });
}
