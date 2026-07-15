# Feedback

## When this process applies

Use when the employee reacts to a specific Minutka response with a quick rating such as 👍, 👌, or 👎. Feedback is a structured application use case: it is linked to the concrete response message, thread, employee, rating, timestamp, and privacy-safe source channel.

## Inputs

- Employee id or privacy-safe resource id.
- Thread id.
- Response/message id being rated.
- Rating value.
- Timestamp.
- Optional short comment if the employee volunteers it.

## Process

1. Treat feedback as a reaction to a specific answer, not as an evaluation of the employee.
2. Save/upsert the rating through the typed application feedback use case.
3. Validate that the rated response belongs to the same employee and thread before saving.
4. Do not require an explanation from the employee.
5. If acknowledgement is needed, keep it short: “Спасибо, учту.”
6. Use feedback as an internal quality signal for answer usefulness and routing, not as company-visible individual performance data.

## Outputs

- Saved structured feedback record with `targetMessageId`, `rating`, `source`, and timestamp.
- `FeedbackReceived` audit event without Telegram transport identifiers.
- Optional short acknowledgement.
- `selectedProcessIds` include `core` and `feedback` for resolver-level tests.

## Privacy notes

- Do not expose individual feedback records to the company or methodologist.
- Do not connect a negative rating to employee performance.
- Keep optional comments private unless transformed into safe aggregate quality signals.
- `source = telegram | cli | test` is privacy-safe audit metadata; Telegram `chatId`, `userId`, callback ids, and message transport metadata must remain outside feedback records/events.

## Anti-patterns

- Asking “why?” after every negative rating.
- Showing individual feedback to company leadership.
- Treating feedback as employee engagement scoring.
- Saving feedback without message/thread linkage.

## Dependencies

- `docs/architecture/minutka-foundation.md`
- `docs/product/virtual-simulation.md#scenario-6-вечерняя-голосовая-рефлексия`
- `docs/product/Final_Description.md#65-reporting-and-automation-map-generation`
