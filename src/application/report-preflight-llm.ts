import { z } from "zod";
import type { PreflightFinding } from "./report-preflight.js";
import { createPreflightFinding } from "./report-preflight.js";

export type ReportPreflightLlmRoutine = {
  routineKey: string;
  name: string;
  variants: string[];
};

const reportPreflightLlmDecisionSchema = z.discriminatedUnion("verdict", [
  z.strictObject({ routineKey: z.string().trim().min(1), verdict: z.literal("ok") }),
  z.strictObject({ routineKey: z.string().trim().min(1), verdict: z.literal("flag"), reason: z.string().trim().min(1).max(500) }),
]);

export const reportPreflightLlmResponseSchema = z.strictObject({
  results: z.array(reportPreflightLlmDecisionSchema),
});

export type ReportPreflightLlmResponse = z.infer<typeof reportPreflightLlmResponseSchema>;
export type ReportPreflightLlmGenerator = (input: {
  routines: ReportPreflightLlmRoutine[];
}) => Promise<{ object?: unknown }>;

export class ReportPreflightLlmError extends Error {
  readonly findings: [] = [];

  constructor(readonly code: "invalid_model_response", message: string) {
    super(message);
    this.name = "ReportPreflightLlmError";
  }
}

export class ReportPreflightLlmService {
  constructor(private readonly generate: ReportPreflightLlmGenerator) {}

  async check(input: { routines: ReportPreflightLlmRoutine[] }): Promise<PreflightFinding[]> {
    const routines = input.routines.map((routine) => ({
      routineKey: routine.routineKey.trim(),
      name: routine.name,
      variants: [...routine.variants],
    }));
    if (routines.length === 0) return [];

    const generated = await this.generate({ routines });
    const parsed = reportPreflightLlmResponseSchema.safeParse(generated.object);
    if (!parsed.success) {
      throw new ReportPreflightLlmError("invalid_model_response", "report preflight LLM response is invalid");
    }

    const expected = new Set(routines.map(({ routineKey }) => routineKey));
    const seen = new Set<string>();
    for (const result of parsed.data.results) {
      if (!expected.has(result.routineKey) || seen.has(result.routineKey)) {
        throw new ReportPreflightLlmError("invalid_model_response", "report preflight LLM response must contain one result per routine");
      }
      seen.add(result.routineKey);
    }
    if (seen.size !== expected.size) {
      throw new ReportPreflightLlmError("invalid_model_response", "report preflight LLM response must contain one result per routine");
    }

    const names = new Map(routines.map((routine) => [routine.routineKey, routine.name]));
    return parsed.data.results
      .filter((result): result is Extract<ReportPreflightLlmResponse["results"][number], { verdict: "flag" }> => result.verdict === "flag")
      .map((result) => createPreflightFinding(
        "routine.name",
        result.routineKey,
        "llm_identifying_detail",
        names.get(result.routineKey)!,
        "high",
        result.reason,
      ));
  }
}
