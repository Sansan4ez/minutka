# /bin/extract-insights

## Purpose

Create and persist structured business-signal insights after an allowed employee turn.

## Mutating

Yes: writes structured insights.

## Input

- employee id
- thread id
- source message id
- current employee text
- Minutka response
- conversation decision
- suggested insight kinds

## Output

Persisted `StructuredInsight` records.

## Rules

- Run only when `insightDecision.candidate = true` and `insight_extraction` is selected.
- Supported kinds: `task_category`, `routine_pattern`, `energy_stress_marker`, `automation_candidate`.
- Do not copy full raw transcript into labels/rationale.
- Do not infer performance ranking or blame.
