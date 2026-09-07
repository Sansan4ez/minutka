import { z } from "zod";
import {
  activityDurationBuckets,
  activitySystems,
  automationCandidateTypes,
  energyStressMarkerTypes,
  routinePatternTypes,
  activityRecurrenceTypes,
  taskCategories,
} from "../domain/insights.js";

export const activityDurationBucketSchema = z.enum(activityDurationBuckets);
export const activitySystemSchema = z.enum(activitySystems);
export const activityRecurrenceValues = activityRecurrenceTypes;
export const activityRecurrenceSchema = z.enum(activityRecurrenceValues);
export type ActivityRecurrence = (typeof activityRecurrenceValues)[number];
export const collectActivitiesMaximumItems = 50;

/**
 * Every field is optional so an incomplete activity stays incomplete rather
 * than receiving a guessed default.
 *
 * Routine pattern, automation candidate, and energy/stress marker are
 * independent closed facets. A single factual activity may carry any explicit
 * combination of them; omitted facets remain unknown and are never inferred.
 */
export const activityCollectionItemSchema = z.strictObject({
  taskCategory: z.enum(taskCategories)
    .describe("Closed activity category. Use unknown only for an explicit factual activity whose category cannot be determined; never use it as a missing-field default.")
    .optional(),
  routinePattern: z.enum(routinePatternTypes)
    .describe("Optional routine/friction facet. Include only when the employee explicitly describes matching workflow friction for this activity. Omit when absent. Use other only for explicit named routine friction outside the taxonomy.")
    .optional(),
  automationCandidate: z.enum(automationCandidateTypes)
    .describe("Optional automation facet. Include only when the employee explicitly states evidence for a matching automation opportunity in this activity. Omit when absent. Use other only for an explicit named opportunity outside the taxonomy.")
    .optional(),
  energyStressMarker: z.enum(energyStressMarkerTypes)
    .describe("Optional work-related energy/stress facet. Include only from an explicit employee signal for this activity; omit when absent. neutral is an explicit value, never a default.")
    .optional(),
  durationBucket: activityDurationBucketSchema
    .describe("Optional closed duration bucket for this factual activity; omit when duration is not known.")
    .optional(),
  system: activitySystemSchema
    .describe("Optional generic system type. Include only for an explicitly named channel/system or an unambiguous generic mapping. Omit an unnamed or ambiguous system. Use other only for an explicit known system type outside the taxonomy.")
    .optional(),
  routineId: z.string().trim().min(1).max(64).optional(),
  routineLabel: z.string().trim().min(3).max(80).optional(),
  recurrence: activityRecurrenceSchema.optional(),
});

/** One provider-visible call records a bounded batch of separate activities. */
export const collectActivitiesInputSchema = z.strictObject({
  activities: z.array(activityCollectionItemSchema).min(1).max(collectActivitiesMaximumItems),
});

export type CollectActivityInput = z.infer<typeof activityCollectionItemSchema>;
export type CollectActivitiesInput = z.infer<typeof collectActivitiesInputSchema>;
