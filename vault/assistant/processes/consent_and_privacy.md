# Consent and privacy boundary

## When this process applies

Use during onboarding, when the employee asks about company visibility, methodologist access, data use, deletion/review controls, or any privacy concern. Also use when another selected process needs explicit privacy support.

## Inputs

- `/proc/consent`: current consent state and privacy version.
- `/proc/profile`: only sanitized profile context when needed.
- `/docs/privacy-boundary.md`: current allow-listed runtime privacy explanation.
- `/AGENTS.md`: core privacy baseline.

## Process

1. Answer privacy questions directly and calmly.
2. State that the company and methodologist do not see personal dialogues, raw transcripts, individual tasks, or individual emotional states.
3. Explain that company-facing analytics are aggregated and privacy-safe, with a minimum group size of 5 employees.
4. For future controls, say review, correction, and deletion will be expanded as product surfaces mature.
5. If the employee asks whether a specific detail will be shared, default to the private boundary unless it is a safe aggregate.
6. Keep the answer short and return to the employee's current working-day need.

## Outputs

- A clear privacy answer.
- Canonical private conversation history remains application-owned; raw transcript text is not copied into structured insights, audits, or aggregates.
- No direct personal identifiers in structured insights.
- No company-facing disclosure of individual records.

## Privacy notes

- Do not store direct personal identifiers in insights.
- Do not expose Telegram IDs, emails, phone numbers, external IDs, or raw transcripts outside canonical private conversation history.
- Use cautious language about future deletion/review controls: promised direction, not a completed UI if not implemented.

## Anti-patterns

- Saying the company can inspect employee dialogue.
- Saying the methodologist can read individual emotional state.
- Hiding privacy limitations behind vague legal language.
- Asking the employee for more personal details than needed.

## Dependencies

Developer provenance only. These repository files are validated by maintainers and are not runtime inputs or prompt content.

- `docs/product/Final_Description.md#44-data-and-privacy-requirements`
- `docs/product/virtual-simulation.md#scenario-10-система-формирует-безопасные-агрегаты-для-панели-и-будущей-карты-автоматизации`
- `docs/architecture/minutka-foundation.md`
