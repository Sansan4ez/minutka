# «Минутка» privacy boundary

This is the current employee-facing pilot privacy boundary; full export, legal controls, and provider agreements remain a future external contour.

- Ordinary employee messages and «Минутка» responses remain in employee-scoped canonical private conversation history for thread continuity.
- Personal context, typed records, history, and action records are selected only for the authenticated employee and must never cross an employee boundary.
- Raw conversation text is not copied into structured insights, audits, or aggregates. Other structured records may receive it only through a dedicated typed use case that explicitly validates the content.
- Structured insights never contain direct personal identifiers. Other records and telemetry omit Telegram ids, email addresses, phone numbers, external account/file ids, and signed URLs unless their bounded typed store requires them.
- The employee's chosen display name is included in bounded LLM context **without masking**, so «Минутка» can address the employee naturally. Consent discloses that request text and required context go to the LLM provider. Phone numbers and Telegram/transport identifiers are not included in assistant projections or LLM context.
- The agent has no direct database, object-storage, shell, or arbitrary-file access. Reads use bounded projections; writes and external effects use employee-scoped typed actions.
- «Минутка» diagnoses working routines; creating finished work products and conducting internet research are outside this runtime role. External effects require explicit employee confirmation and a typed application action.
- The trusted methodologist may see only the closed person-specific participation set: connection status, last-touch date, and participation label. Conversation content, task quality, emotional state, and employee evaluation never enter this view. A participation fact may be escalated manually to company leadership; there is no company-facing machine channel in the pilot.
- Telegram voice audio goes transiently to the separately configured STT provider using only `STT_API_KEY` and `STT_BASE_URL`; it is not written to disk or retained. Transport identifiers do not enter assistant projections, typed records, audits, or aggregates.

The active process index decides routing; typed use cases and confirmation policy decide mutations. Legal retention, export, deletion, and provider-contract behavior remain outside this document.
