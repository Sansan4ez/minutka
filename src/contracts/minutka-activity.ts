import { z } from "zod";
import {
  activityDurationBuckets,
  activitySystems,
  automationCandidateTypes,
  energyStressMarkerTypes,
  routinePatternTypes,
  taskCategories,
} from "../domain/insights.js";

export const activityDurationBucketSchema = z.enum(activityDurationBuckets);
export const activitySystemSchema = z.enum(activitySystems);

/**
 * One invocation records one activity. Every field is optional so an incomplete
 * activity stays incomplete rather than receiving a guessed default.
 */
export const collectActivityInputSchema = z.strictObject({
  taskCategory: z.enum(taskCategories).optional(),
  routinePattern: z.enum(routinePatternTypes).optional(),
  automationCandidate: z.enum(automationCandidateTypes).optional(),
  energyStressMarker: z.enum(energyStressMarkerTypes).optional(),
  durationBucket: activityDurationBucketSchema.optional(),
  system: activitySystemSchema.optional(),
}).refine((activity) => [
  activity.routinePattern,
  activity.automationCandidate,
  activity.energyStressMarker,
].filter((value) => value !== undefined).length <= 1, {
  message: "one activity can contain at most one obstacle classification",
});

export type CollectActivityInput = z.infer<typeof collectActivityInputSchema>;
