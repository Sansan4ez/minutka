# Consent and privacy boundary

## When this process applies

Use during onboarding, when the owner asks what is stored, which providers receive data, how external actions are controlled, or about retention, export, deletion, and any other privacy concern. Also use when another selected process needs explicit privacy support.

## Inputs

- `/proc/consent`: current consent state and privacy version.
- `/proc/profile`: only sanitized profile context when needed.
- `/docs/privacy-boundary.md`: current allow-listed runtime privacy explanation.
- `/AGENTS.md`: core privacy baseline.

## Process

1. Answer privacy questions directly and calmly.
2. Explain the actual owner-scoped data contour: conversation history, profile, context documents, typed records, and uploaded artifacts.
3. State that request text and selected context go to the configured LLM provider; voice audio goes separately to the configured STT provider and is not retained by this application.
4. State that the agent has no direct database, object-storage, shell, or arbitrary-file access; external effects require explicit owner confirmation and a typed application action.
5. Be explicit that legal retention periods, full export, and complete deletion procedures are not yet approved product capabilities. Link to `/docs/privacy-boundary.md` for the current boundary without promising future behavior.
6. Keep the answer short and return to the owner's current need.

## Outputs

- A clear privacy answer.
- Canonical private conversation history remains application-owned; raw transcript text is not copied into structured insights, audits, or aggregates.
- No direct personal identifiers in structured insights.
- No cross-owner disclosure of individual records.

## Privacy notes

- Do not store direct personal identifiers in insights.
- Do not expose Telegram IDs, emails, phone numbers, external IDs, or raw transcripts outside canonical private conversation history.
- Use cautious language about future deletion/review controls: promised direction, not a completed UI if not implemented.

## Anti-patterns

- Claiming that any third party cannot inspect provider-side data unless the configured provider contract proves it.
- Presenting unimplemented retention, export, or complete deletion controls as available.
- Hiding privacy limitations behind vague legal language.
- Asking the employee for more personal details than needed.

## Dependencies

Developer provenance only. These repository files are validated by maintainers and are not runtime inputs or prompt content.

- `docs/product/Final_Description.md#44-data-and-privacy-requirements`
- `docs/product/virtual-simulation.md#scenario-10-система-формирует-безопасные-агрегаты-для-панели-и-будущей-карты-автоматизации`
- `docs/architecture/minutka-foundation.md`
