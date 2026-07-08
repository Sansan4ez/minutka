# Feedback

## When this process applies

Use when the employee reacts to a specific Minutka response with a quick rating such as 👍, 👌, or 👎. In Phase 3.5 this is a prepared routing target; persistent feedback storage is planned for Phase 4.

## Inputs

- Employee id or privacy-safe resource id.
- Thread id.
- Response/message id being rated.
- Rating value.
- Timestamp.
- Optional short comment if the employee volunteers it.

## Process

1. Treat feedback as a reaction to a specific answer, not as an evaluation of the employee.
2. Save the rating through a typed application use case when Phase 4 implements it.
3. Do not require an explanation from the employee.
4. If acknowledgement is needed, keep it short: “Спасибо, учту.”
5. Use feedback as an internal quality signal for answer usefulness and routing, not as company-visible individual performance data.

## Outputs

- Saved feedback event/result when the use case exists.
- Optional short acknowledgement.
- `selectedProcessIds` include `core` and `feedback` for resolver-level tests.

## Privacy notes

- Do not expose individual feedback records to the company or methodologist.
- Do not connect a negative rating to employee performance.
- Keep optional comments private unless transformed into safe aggregate quality signals.

## Anti-patterns

- Asking “why?” after every negative rating.
- Showing individual feedback to company leadership.
- Treating feedback as employee engagement scoring.
- Saving feedback without message/thread linkage.

## Dependencies

- `docs/plans/time-agent-mastra-plan.md#phase-4-feedback-loop-and-telegram-shell`
- `docs/product/virtual-simulation.md#scenario-6-вечерняя-голосовая-рефлексия`
- `docs/product/Final_Description.md#65-reporting-and-automation-map-generation`
