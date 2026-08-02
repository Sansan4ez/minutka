# Privacy boundary

This is the current single-owner prototype privacy boundary; full retention, export, deletion, legal controls, and provider agreements remain a future external contour.

- Ordinary owner messages and assistant responses remain in owner-scoped canonical private conversation history for thread continuity.
- Personal context, typed records, inbox artifacts, history, and action records are selected only for the authenticated owner and must never cross an owner boundary.
- Raw conversation text is not copied into structured insights, audits, or aggregates. Other structured records may receive it only through a dedicated typed use case that explicitly validates the content.
- Structured insights never contain direct personal identifiers. Other records and telemetry omit Telegram ids, email addresses, phone numbers, external account/file ids, and signed URLs unless their bounded typed store requires them.
- The agent has no direct database, object-storage, shell, or arbitrary-file access. Reads use bounded projections; writes and external effects use owner-scoped typed actions.
- Drafting is allowed. Sending, publishing, calendar changes, integrations, and financial, legal, or other external commitments require explicit owner confirmation and a typed application action.
- Telegram voice audio goes transiently to the separately configured STT provider using only `STT_API_KEY` and `STT_BASE_URL`; it is not written to disk or retained. Transport identifiers do not enter assistant projections, typed records, audits, or aggregates.

The active process index decides routing; typed use cases and confirmation policy decide mutations. Legal retention, export, deletion, and provider-contract behavior remain outside this document.
