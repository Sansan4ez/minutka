import { z } from "zod";
import { activityCollectionItemSchema, type CollectActivitiesInput, type CollectActivityInput } from "../contracts/minutka-activity.js";
import type { ActivityDurationBucket } from "../domain/insights.js";
import type { CorrectRecentActivityInput } from "./activity-correction.js";

export type DurationEvidenceCandidate = {
  ref: string;
  bucket: ActivityDurationBucket;
  sourceOrder: number;
};

export type ProviderActivityInput = Omit<CollectActivityInput, "durationBucket"> & { durationRef?: string };
export type ProviderCollectActivitiesInput = { activities: ProviderActivityInput[] };
export type ProviderActivityCorrection = Omit<CorrectRecentActivityInput["correction"], "durationBucket"> & { durationRef?: string };
export type ProviderCorrectRecentActivityInput = Omit<CorrectRecentActivityInput, "correction"> & { correction: ProviderActivityCorrection };

const integerDurationPattern = /(?<![\p{L}\p{N}])(?<amount>\d+(?:[.,]\d+)?)[\s\u00a0\u202f-]*(?<unit>минут(?:а|ы|ную|ный|ное)?|мин|час(?:а|ов|овой|овая|овое)?|ч|minutes?|mins?|hours?|hrs?)(?![\p{L}\p{N}])/giu;
const halfHourPattern = /(?<![\p{L}\p{N}])(?:полчаса|half[\s\u00a0\u202f-]*an?[\s\u00a0\u202f-]*hour)(?![\p{L}\p{N}])/giu;
const oneAndHalfHourPattern = /(?<![\p{L}\p{N}])(?:полтора|полторы)\s*час(?:а|ов)?(?![\p{L}\p{N}])/giu;

export function extractDurationEvidence(text: string): DurationEvidenceCandidate[] {
  const matches: Array<{ index: number; minutes: number }> = [];
  collectMatches(halfHourPattern, text, () => 30, matches);
  collectMatches(oneAndHalfHourPattern, text, () => 90, matches);
  collectMatches(integerDurationPattern, text, (match) => {
    const groups = match.groups as { amount?: string; unit?: string } | undefined;
    const amount = Number((groups?.amount ?? "").replace(",", "."));
    if (!Number.isFinite(amount) || amount <= 0) return undefined;
    return /^(?:час|ч|hour|hr)/iu.test(groups?.unit ?? "") ? amount * 60 : amount;
  }, matches);
  matches.sort((left, right) => left.index - right.index);
  const uniqueMatches = matches.filter((match, index) => index === 0 || match.index !== matches[index - 1]?.index);
  return uniqueMatches.map((match, sourceOrder) => ({
    ref: `duration_${sourceOrder + 1}`,
    bucket: durationBucketForMinutes(match.minutes),
    sourceOrder,
  }));
}

export function createProviderActivitySchemas(candidates: readonly DurationEvidenceCandidate[]) {
  const { durationBucket: _durationBucket, ...canonicalShape } = activityCollectionItemSchema.shape;
  const providerShape = candidates.length === 0
    ? canonicalShape
    : { ...canonicalShape, durationRef: requestDurationRefSchema(candidates) };
  return {
    collectionItem: z.strictObject(providerShape),
    correctionPatch: z.strictObject(providerShape),
  };
}

export class RequestDurationEvidence {
  private readonly byRef: Map<string, DurationEvidenceCandidate>;
  private readonly consumed = new Set<string>();

  constructor(readonly candidates: readonly DurationEvidenceCandidate[]) {
    this.byRef = new Map(candidates.map((candidate) => [candidate.ref, candidate]));
  }

  prepareCollection(input: ProviderCollectActivitiesInput): { input: CollectActivitiesInput; refsByActivity: Array<string | undefined> } {
    const refsByActivity = input.activities.map((activity) => activity.durationRef);
    this.assertAvailable(refsByActivity.filter((ref): ref is string => ref !== undefined));
    return {
      input: {
        activities: input.activities.map(({ durationRef, ...activity }) => ({
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
    const { durationRef, ...correction } = input.correction;
    const refs = durationRef === undefined ? [] : [durationRef];
    this.assertAvailable(refs);
    return {
      input: {
        ...input,
        correction: {
          ...correction,
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

function collectMatches(
  pattern: RegExp,
  text: string,
  minutes: (match: RegExpExecArray) => number | undefined,
  target: Array<{ index: number; minutes: number }>,
): void {
  pattern.lastIndex = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const value = minutes(match);
    if (value !== undefined) target.push({ index: match.index, minutes: value });
  }
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
  return z.enum(refs).describe(description).optional();
}
