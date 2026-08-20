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
export const collectActivitiesMaximumItems = 50;

/**
 * Every field is optional so an incomplete activity stays incomplete rather
 * than receiving a guessed default.
 *
 * The three obstacle fields are alternative lenses on the same «what got in the
 * way» answer, and both the tool description and the process ask for at most
 * one of them. That rule is deliberately not a schema check: JSON Schema cannot
 * carry a cross-field constraint, so the provider never shows it to the model.
 * One obstacle per stored activity is guaranteed downstream by
 * `activityObstacle`.
 */
export const activityCollectionItemSchema = z.strictObject({
  taskCategory: z.enum(taskCategories).optional(),
  routinePattern: z.enum(routinePatternTypes).optional(),
  automationCandidate: z.enum(automationCandidateTypes).optional(),
  energyStressMarker: z.enum(energyStressMarkerTypes).optional(),
  durationBucket: activityDurationBucketSchema.optional(),
  system: activitySystemSchema.optional(),
});

/** One provider-visible call records a bounded batch of separate activities. */
export const collectActivitiesInputSchema = z.strictObject({
  activities: z.array(activityCollectionItemSchema).min(1).max(collectActivitiesMaximumItems),
});

export type CollectActivityInput = z.infer<typeof activityCollectionItemSchema>;
export type CollectActivitiesInput = z.infer<typeof collectActivitiesInputSchema>;
