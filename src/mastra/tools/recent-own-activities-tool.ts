import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { RecentOwnActivitiesResult } from "../../application/recent-own-activities.js";
import {
  activityDurationBuckets,
  activitySystems,
  automationCandidateTypes,
  energyStressMarkerTypes,
  activityRecurrenceTypes,
  routinePatternTypes,
  taskCategories,
} from "../../domain/insights.js";

export const readRecentOwnActivitiesToolName = "readRecentOwnActivities" as const;

export const recentOwnActivitySchema = z.strictObject({
  handle: z.string().min(1),
  revision: z.number().int().min(1),
  taskCategory: z.enum(taskCategories).optional(),
  routinePattern: z.enum(routinePatternTypes).optional(),
  automationCandidate: z.enum(automationCandidateTypes).optional(),
  energyStressMarker: z.enum(energyStressMarkerTypes).optional(),
  routineId: z.string().min(1).optional(),
  routineLabel: z.string().min(1).optional(),
  recurrence: z.enum(activityRecurrenceTypes).optional(),
  durationBucket: z.enum(activityDurationBuckets).optional(),
  system: z.enum(activitySystems).optional(),
  activityDate: z.string(),
  recordedAt: z.string(),
});

export const recentOwnActivitiesResultSchema = z.strictObject({
  activities: z.array(recentOwnActivitySchema),
});

/** Reads a small recent owner-scoped candidate set; it records and changes nothing. */
export function createReadRecentOwnActivitiesTool(
  readRecentOwnActivities: () => Promise<RecentOwnActivitiesResult>,
) {
  return createTool({
    id: readRecentOwnActivitiesToolName,
    description: "Read a small short-window list of the authenticated employee's own recent structured activities only when the employee explicitly corrects or clarifies a previous activity, or refers unambiguously to one. Never call before ordinary activity collection or to deduplicate repeated work. If several candidates fit, ask one short clarification; if none fit, change nothing and do not reinterpret the new account as a duplicate. The result contains only closed facets, local activity date, recorded time, and an opaque handle/revision for a later typed correction step; it contains no raw text or identity fields.",
    strict: true,
    inputSchema: z.strictObject({}),
    outputSchema: recentOwnActivitiesResultSchema,
    mcp: { annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
    execute: async () => readRecentOwnActivities(),
  });
}
