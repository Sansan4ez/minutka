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
import type { CycleActivitySummary } from "../../application/cycle-activity-summary.js";

export const readCycleActivitiesToolName = "readCycleActivities" as const;

const tallySchema = <Values extends readonly [string, ...string[]]>(values: Values) =>
  z.array(z.strictObject({ value: z.enum(values), count: z.number().int().min(1) }));

export const cycleActivitySummarySchema = z.strictObject({
  fromDate: z.string(),
  toDate: z.string(),
  activityCount: z.number().int().min(0),
  activeDates: z.number().int().min(0),
  sufficientData: z.boolean(),
  patternMinimumCount: z.number().int().min(1),
  taskCategories: tallySchema(taskCategories),
  routinePatterns: tallySchema(routinePatternTypes),
  automationCandidates: tallySchema(automationCandidateTypes),
  energyStressMarkers: tallySchema(energyStressMarkerTypes),
  durationBuckets: tallySchema(activityDurationBuckets),
  systems: tallySchema(activitySystems),
  confirmedPatterns: z.strictObject({
    taskCategories: z.array(z.enum(taskCategories)),
    routinePatterns: z.array(z.enum(routinePatternTypes)),
    automationCandidates: z.array(z.enum(automationCandidateTypes)),
    energyStressMarkers: z.array(z.enum(energyStressMarkerTypes)),
    systems: z.array(z.enum(activitySystems)),
  }),
});

/** Reads the authenticated employee's own counted cycle; it records nothing. */
export function createReadCycleActivitiesTool(readCycleActivities: () => Promise<CycleActivitySummary>) {
  return createTool({
    id: readCycleActivitiesToolName,
    description: "Read counted structured activities the authenticated employee reported over the last fourteen days. Counts come from the application, not from the model: name only what this result contains, call a pattern only what confirmedPatterns lists, and when sufficientData is false say the cycle is too thin instead of describing a pattern.",
    strict: true,
    inputSchema: z.strictObject({}),
    outputSchema: cycleActivitySummarySchema,
    mcp: { annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
    execute: async () => readCycleActivities(),
  });
}
