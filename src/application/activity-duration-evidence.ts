import { z } from "zod";
import { activityCollectionItemSchema, type CollectActivitiesInput, type CollectActivityInput } from "../contracts/minutka-activity.js";
import type { ActivityDurationBucket } from "../domain/insights.js";
import type { CorrectRecentActivityInput } from "./activity-correction.js";

export const MAX_DURATION_REFERENCES = 32;

export type DurationEvidenceCandidate = {
  ref: string;
  bucket: ActivityDurationBucket;
  sourceOrder: number;
};

export type ProviderActivityInput = Omit<CollectActivityInput, "durationBucket" | "routineId" | "routineLabel" | "recurrence"> & {
  routineId?: string | null;
  routineLabel?: string | null;
  recurrence?: CollectActivityInput["recurrence"] | null;
  durationRef?: string;
};
export type ProviderCollectActivitiesInput = { activities: ProviderActivityInput[] };
export type ProviderActivityCorrection = Omit<CorrectRecentActivityInput["correction"], "durationBucket" | "routineId" | "routineLabel" | "recurrence"> & {
  routineId?: string | null;
  routineLabel?: string | null;
  recurrence?: CorrectRecentActivityInput["correction"]["recurrence"] | null;
  durationRef?: string;
};
export type ProviderCorrectRecentActivityInput = Omit<CorrectRecentActivityInput, "correction"> & { correction: ProviderActivityCorrection };

const integerDurationPattern = /(?<![\p{L}\p{N}])(?<amount>\d+(?:[.,]\d+)?)[\s\u00a0\u202f-]*(?<unit>минут(?:а|ы|ную|ный|ное)?|мин|час(?:а|ов|овой|овая|овое)?|ч|minutes?|mins?|hours?|hrs?)(?![\p{L}\p{N}])/giu;
const reversedIntegerDurationPattern = /(?<![\p{L}\p{N}])(?<unit>минут(?:а|ы)?|мин|час(?:а|ов)?|ч|minutes?|mins?|hours?|hrs?)[\s\u00a0\u202f-]*(?<amount>\d+(?:[.,]\d+)?)(?![\p{L}\p{N}])/giu;
const halfHourPattern = /(?<![\p{L}\p{N}])(?:полчаса|half[\s\u00a0\u202f-]*an?[\s\u00a0\u202f-]*hour)(?![\p{L}\p{N}])/giu;
const oneAndHalfHourPattern = /(?<![\p{L}\p{N}])(?:полтора|полторы)\s*час(?:а|ов)?(?![\p{L}\p{N}])/giu;
const durationOnlyResiduePattern = /^(?:(?:уже|всего|примерно|приблизительно|около|где[\s-]*то|почти|заняло|занимало|получилось|это|ещ[её]|about|around|approximately|roughly|already|just|took|and|и)\s*)*$/iu;

export function extractDurationEvidence(text: string): DurationEvidenceCandidate[] {
  return resolveDurationMatches(text).matches
    .slice(0, MAX_DURATION_REFERENCES)
    .map((match, sourceOrder) => ({
      ref: `duration_${sourceOrder + 1}`,
      bucket: durationBucketForMinutes(match.minutes),
      sourceOrder,
    }));
}

/** A bounded guard for replies that add duration but name no work object. */
export function isDurationOnlyActivityReply(text: string): boolean {
  return resolveDurationMatches(text).durationOnly;
}

function resolveDurationMatches(text: string): { matches: DurationMatch[]; durationOnly: boolean } {
  const directMatches: DurationMatch[] = [];
  collectMatches(halfHourPattern, text, () => ({ minutes: 30, unit: "hours" }), directMatches);
  collectMatches(oneAndHalfHourPattern, text, () => ({ minutes: 90, unit: "hours" }), directMatches);
  collectMatches(integerDurationPattern, text, numericDuration, directMatches);

  const reversedMatches: DurationMatch[] = [];
  collectMatches(reversedIntegerDurationPattern, text, numericDuration, reversedMatches);

  const allMatches = normalizeDurationMatches([...directMatches, ...reversedMatches], text);
  const durationOnly = allMatches.length > 0 && hasDurationOnlyResidue(text, allMatches);
  return {
    matches: durationOnly ? allMatches : normalizeDurationMatches(directMatches, text),
    durationOnly,
  };
}

function normalizeDurationMatches(matches: DurationMatch[], text: string): DurationMatch[] {
  matches.sort((left, right) => left.index - right.index || right.end - left.end);
  const nonOverlapping: DurationMatch[] = [];
  for (const match of matches) {
    if (nonOverlapping.length === 0 || match.index >= nonOverlapping.at(-1)!.end) nonOverlapping.push(match);
  }
  return mergeCompoundDurationMatches(nonOverlapping, text);
}

function hasDurationOnlyResidue(text: string, matches: readonly DurationMatch[]): boolean {
  let residue = "";
  let cursor = 0;
  for (const match of matches) {
    residue += `${text.slice(cursor, match.index)} `;
    cursor = match.end;
  }
  residue += text.slice(cursor);
  const normalized = residue
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return durationOnlyResiduePattern.test(normalized);
}

function numericDuration(match: RegExpExecArray): Pick<DurationMatch, "minutes" | "unit"> | undefined {
  const groups = match.groups as { amount?: string; unit?: string } | undefined;
  const amount = Number((groups?.amount ?? "").replace(",", "."));
  if (!Number.isFinite(amount) || amount <= 0) return undefined;
  const unit = /^(?:час|ч|hour|hr)/iu.test(groups?.unit ?? "") ? "hours" : "minutes";
  return { minutes: unit === "hours" ? amount * 60 : amount, unit };
}

export function createProviderActivitySchemas(candidates: readonly DurationEvidenceCandidate[]) {
  const { durationBucket: _durationBucket, ...canonicalShape } = activityCollectionItemSchema.shape;
  const providerShape = Object.fromEntries(Object.entries(canonicalShape).map(([key, schema]) => [
    key,
    providerNullable(schema.unwrap()),
  ])) as unknown as {
    taskCategory: ReturnType<typeof providerNullable<typeof canonicalShape.taskCategory>>;
    routinePattern: ReturnType<typeof providerNullable<typeof canonicalShape.routinePattern>>;
    automationCandidate: ReturnType<typeof providerNullable<typeof canonicalShape.automationCandidate>>;
    energyStressMarker: ReturnType<typeof providerNullable<typeof canonicalShape.energyStressMarker>>;
    system: ReturnType<typeof providerNullable<typeof canonicalShape.system>>;
  };
  const correctionProviderShape = {
    ...providerShape,
    routineId: providerNullable(activityCollectionItemSchema.shape.routineId.unwrap()).optional(),
    routineLabel: providerNullable(activityCollectionItemSchema.shape.routineLabel.unwrap()).optional(),
    recurrence: providerNullable(activityCollectionItemSchema.shape.recurrence.unwrap()).optional(),
  };
  const shapeWithDuration = candidates.length === 0
    ? providerShape
    : { ...providerShape, durationRef: requestDurationRefSchema(candidates) };
  const correctionShapeWithDuration = candidates.length === 0
    ? correctionProviderShape
    : { ...correctionProviderShape, durationRef: requestDurationRefSchema(candidates) };
  type TransportShape = {
    taskCategory: z.ZodOptional<typeof shapeWithDuration.taskCategory>;
    routinePattern: z.ZodOptional<typeof shapeWithDuration.routinePattern>;
    automationCandidate: z.ZodOptional<typeof shapeWithDuration.automationCandidate>;
    energyStressMarker: z.ZodOptional<typeof shapeWithDuration.energyStressMarker>;
    system: z.ZodOptional<typeof shapeWithDuration.system>;
    durationRef?: z.ZodOptional<z.ZodType<string | undefined>>;
  };
  const transportShape = shapeWithDuration as unknown as TransportShape;
  return {
    collectionItem: z.strictObject(transportShape),
    correctionPatch: z.strictObject(correctionShapeWithDuration),
  };
}

export class RequestDurationEvidence {
  private readonly byRef: Map<string, DurationEvidenceCandidate>;
  private readonly consumed = new Set<string>();

  constructor(readonly candidates: readonly DurationEvidenceCandidate[]) {
    this.byRef = new Map(candidates.map((candidate) => [candidate.ref, candidate]));
  }

  prepareCollection(input: ProviderCollectActivitiesInput): { input: CollectActivitiesInput; refsByActivity: Array<string | undefined> } {
    const activities = input.activities.map(({ durationRef, ...activity }) => ({
      activity: withoutNullValues(activity),
      durationRef: durationRef ?? undefined,
    }));
    const refsByActivity = activities.map(({ durationRef }) => durationRef);
    this.assertAvailable(refsByActivity.filter((ref): ref is string => ref !== undefined));
    return {
      input: {
        activities: activities.map(({ activity, durationRef }) => ({
          ...activity,
          ...(durationRef === undefined ? {} : { durationBucket: this.byRef.get(durationRef)!.bucket }),
        })),
      },
      refsByActivity,
    };
  }

  consumeCollection(refsByActivity: readonly (string | undefined)[], savedCount: number): void {
    this.consume(refsByActivity.slice(0, savedCount).filter((ref): ref is string => ref !== undefined));
  }

  prepareCorrection(input: ProviderCorrectRecentActivityInput): { input: CorrectRecentActivityInput; durationRef?: string } {
    const { durationRef: providerDurationRef, ...providerCorrection } = input.correction;
    const durationRef = providerDurationRef ?? undefined;
    const refs = durationRef === undefined ? [] : [durationRef];
    this.assertAvailable(refs);
    return {
      input: {
        ...input,
        correction: {
          ...withoutNullValuesForCorrection(providerCorrection),
          ...(durationRef === undefined ? {} : { durationBucket: this.byRef.get(durationRef)!.bucket }),
        },
      },
      ...(durationRef === undefined ? {} : { durationRef }),
    };
  }

  consumeCorrection(durationRef: string | undefined): void {
    if (durationRef !== undefined) this.consume([durationRef]);
  }

  private assertAvailable(refs: readonly string[]): void {
    const seen = new Set<string>();
    for (const ref of refs) {
      if (!this.byRef.has(ref)) throw new DurationEvidenceValidationError("unknown_duration_ref");
      if (seen.has(ref) || this.consumed.has(ref)) throw new DurationEvidenceValidationError("duration_ref_already_used");
      seen.add(ref);
    }
  }

  private consume(refs: readonly string[]): void {
    for (const ref of refs) this.consumed.add(ref);
  }
}

export class DurationEvidenceValidationError extends Error {
  readonly detail: { code: "unknown_duration_ref" | "duration_ref_already_used" };

  constructor(code: DurationEvidenceValidationError["detail"]["code"]) {
    super(code);
    this.name = "DurationEvidenceValidationError";
    this.detail = { code };
  }
}

type DurationMatch = {
  index: number;
  end: number;
  minutes: number;
  unit: "hours" | "minutes";
};

function collectMatches(
  pattern: RegExp,
  text: string,
  value: (match: RegExpExecArray) => Pick<DurationMatch, "minutes" | "unit"> | undefined,
  target: DurationMatch[],
): void {
  pattern.lastIndex = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const duration = value(match);
    if (duration !== undefined) target.push({ index: match.index, end: match.index + match[0].length, ...duration });
  }
}

function mergeCompoundDurationMatches(matches: readonly DurationMatch[], text: string): DurationMatch[] {
  const merged: DurationMatch[] = [];
  for (let index = 0; index < matches.length; index += 1) {
    const current = matches[index]!;
    const next = matches[index + 1];
    const separator = next === undefined ? undefined : text.slice(current.end, next.index);
    if (
      current.unit === "hours"
      && next?.unit === "minutes"
      && separator !== undefined
      && /^[\s\u00a0\u202f]*,?[\s\u00a0\u202f]*(?:и[\s\u00a0\u202f]*)?$/iu.test(separator)
    ) {
      merged.push({ ...current, end: next.end, minutes: current.minutes + next.minutes });
      index += 1;
    } else {
      merged.push(current);
    }
  }
  return merged;
}

function durationBucketForMinutes(minutes: number): ActivityDurationBucket {
  if (minutes < 15) return "lt_15m";
  if (minutes <= 30) return "15_30m";
  if (minutes <= 60) return "30_60m";
  if (minutes <= 120) return "1_2h";
  if (minutes <= 240) return "2_4h";
  return "gt_4h";
}

function requestDurationRefSchema(candidates: readonly DurationEvidenceCandidate[]) {
  const refs = candidates.map(({ ref }) => ref) as [string, ...string[]];
  const description = `Optional request-local explicit-duration reference. Associate only the correct factual activity. Each ref can be used once in the turn. Available refs in source order: ${candidates.map(({ ref, bucket }) => `${ref} (${bucket})`).join(", ")}.`;
  return providerNullable(z.enum(refs).describe(description)) as z.ZodType<string | undefined>;
}

function providerNullable<T extends z.ZodType>(schema: T) {
  return z.preprocess(
    (value) => value === undefined ? null : value,
    schema.nullable().transform((value) => value === null ? undefined : value),
  );
}

function withoutNullValues<T extends Record<string, unknown>>(input: T): {
  [Key in keyof T]?: Exclude<T[Key], null>;
} {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== null)) as {
    [Key in keyof T]?: Exclude<T[Key], null>;
  };
}

function withoutNullValuesForCorrection<T extends Record<string, unknown>>(input: T): T {
  const result = { ...withoutNullValues(input) } as Record<string, unknown>;
  for (const key of ["routineId", "routineLabel", "recurrence"] as const) {
    if (input[key] === null) result[key] = null;
  }
  return result as T;
}
