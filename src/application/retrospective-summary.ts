import type { RetrospectiveScope, RetrospectiveStatement, WorkRetrospectiveEpisode } from "../domain/work-retrospective.js";
import { sameScope } from "./retrospective-event-store.js";
import type { WeeklyActivitySummary } from "./weekly-activity-summary.js";
import type { CycleActivitySummary } from "./cycle-activity-summary.js";
import type { RetrospectiveOutcome, WorkRetrospectiveUseCases } from "./work-retrospective-store.js";

import { z } from "zod";
import { workRetrospectiveEpisodeSchema } from "./work-retrospective-store.js";
const statements = workRetrospectiveEpisodeSchema.shape.statements.shape.actions;
export const personalRetrospectiveProjectionSchema = z.strictObject({
  episodePeriod: workRetrospectiveEpisodeSchema.shape.period,
  episodes: z.array(z.strictObject({
    period: workRetrospectiveEpisodeSchema.shape.period,
    confirmed: statements, tried: statements, observations: statements,
    interpretations: statements, hypotheses: statements, intentions: statements,
    followUp: z.strictObject({ step: workRetrospectiveEpisodeSchema.shape.selectedStep.unwrap(), indicator: workRetrospectiveEpisodeSchema.shape.indicator, question: z.string() }).optional(),
  })),
});
export type PersonalRetrospectiveProjection = z.infer<typeof personalRetrospectiveProjectionSchema>;

export type RetrospectiveSummaryInput = {
  /** Bound by the application, never supplied by the model. */
  scope: RetrospectiveScope;
  /** Full group period, including week-one steps during a week-two checkpoint. */
  period: { start: string; end: string };
};
export type PersonalRetrospectiveEpisode = {
  period: WorkRetrospectiveEpisode["period"];
  confirmed: RetrospectiveStatement[];
  /** Employee-reported actions, not proof that the selected intention succeeded. */
  tried: RetrospectiveStatement[];
  observations: RetrospectiveStatement[];
  interpretations: RetrospectiveStatement[];
  hypotheses: RetrospectiveStatement[];
  intentions: RetrospectiveStatement[];
  followUp?: {
    step: NonNullable<WorkRetrospectiveEpisode["selectedStep"]>;
    indicator?: WorkRetrospectiveEpisode["indicator"];
    question: string;
  };
};
export type PersonalRetrospectiveSummary<T> = {
  facts: T;
  episodePeriod: RetrospectiveSummaryInput["period"];
  episodes: PersonalRetrospectiveEpisode[];
};

/** Read-only personal projection. No correction handles, synthetic activities or writes.
 * T4b binds these exports to request-scoped tools; disabled groups retain existing reads.
 */
export class RetrospectiveSummaryService {
  constructor(private readonly episodes: Pick<WorkRetrospectiveUseCases, "readEpisodes">) {}

  async summarize<T extends WeeklyActivitySummary | CycleActivitySummary>(
    input: RetrospectiveSummaryInput,
    readFacts: () => Promise<T>,
  ): Promise<RetrospectiveOutcome<PersonalRetrospectiveSummary<T>>> {
    if (!Number.isFinite(Date.parse(input.period.start)) || !Number.isFinite(Date.parse(input.period.end))
      || Date.parse(input.period.start) > Date.parse(input.period.end)) {
      return { status: "failed", code: "validation_error" };
    }
    const result = await this.episodes.readEpisodes({ scope: input.scope, period: input.period, limit: 100 });
    if (!("value" in result)) return result;
    // The current read port has no cursor: never silently present a truncated cycle as complete.
    if (result.value.length >= 100) return { status: "failed", code: "context_budget_error" };
    const own = result.value.filter((episode) => sameScope(episode, input.scope)
      && Date.parse(episode.period.start) <= Date.parse(input.period.end)
      && Date.parse(episode.period.end) >= Date.parse(input.period.start));
    return {
      status: "applied",
      value: {
        facts: await readFacts(), // Preserve sufficiency, counts, confidence and local-date boundaries verbatim.
        episodePeriod: { ...input.period },
        episodes: own.map(personalEpisode),
      },
    };
  }
}

function personalEpisode(episode: WorkRetrospectiveEpisode): PersonalRetrospectiveEpisode {
  const all = Object.values(episode.statements).flat();
  return structuredClone({
    period: episode.period,
    confirmed: all.filter((s) => s.kind === "employee_fact"),
    tried: episode.statements.actions.filter((s) => s.kind === "employee_fact"),
    observations: episode.statements.indicators.filter((s) => s.kind === "employee_fact"),
    interpretations: all.filter((s) => s.kind === "employee_interpretation"),
    hypotheses: all.filter((s) => s.kind === "agent_hypothesis"),
    intentions: [...all.filter((s) => s.kind === "intention"), ...(episode.selectedStep ? [episode.selectedStep] : [])],
    ...(episode.followUpConsent?.granted && episode.selectedStep ? {
      followUp: {
        step: episode.selectedStep,
        ...(episode.indicator ? { indicator: episode.indicator } : {}),
        question: "Удалось ли попробовать выбранный шаг? Что вы наблюдали? Можно пропустить; разберём один случай только если вы хотите.",
      },
    } : {}),
  });
}
