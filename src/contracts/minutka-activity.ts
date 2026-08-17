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
 *
 * The three obstacle fields are alternative lenses on the same «what got in the
 * way» answer, and both the tool description and the process ask for at most
 * one of them. That rule is deliberately not a schema check: JSON Schema cannot
 * carry a cross-field constraint, so the provider never shows it to the model,
 * and a rejected call costs the whole daily touch — the model retries until the
 * step ceiling and the turn ends without text. One obstacle per stored activity
 * is guaranteed downstream instead, by `activityObstacle`.
 */
export const collectActivityInputSchema = z.strictObject({
  taskCategory: z.enum(taskCategories).optional(),
  routinePattern: z.enum(routinePatternTypes).optional(),
  automationCandidate: z.enum(automationCandidateTypes).optional(),
  energyStressMarker: z.enum(energyStressMarkerTypes).optional(),
  durationBucket: activityDurationBucketSchema.optional(),
  system: activitySystemSchema.optional(),
});

export type CollectActivityInput = z.infer<typeof collectActivityInputSchema>;
