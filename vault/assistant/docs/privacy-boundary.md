# Privacy boundary

This document describes the current single-owner prototype privacy boundary. Full retention, export, deletion, legal controls, and data processing agreements remain a future external contour.

## Current explanation

- The application keeps the owner's ordinary messages and assistant responses in owner-scoped canonical private conversation history for thread continuity.
- Personal context documents, typed records, inbox artifacts, conversation history, and action records are selected only for the authenticated owner. They must never cross an owner boundary.
- Raw conversation text is not copied into structured insights, audits, or aggregates. Other structured records may receive it only through a dedicated typed use-case that explicitly requires and validates that content.
- Structured insights never contain direct personal identifiers. Other structured records and operational telemetry must not contain transport or account identifiers such as Telegram ids, email addresses, phone numbers, external account ids, file ids, or signed URLs unless the owning typed store requires them for its bounded purpose.
- The agent has no direct database, object-storage, shell, or arbitrary-file access. Reads come from bounded projections; writes and external effects require owner-scoped typed application actions.
- Drafting content is allowed. Sending, publishing, changing a calendar, connecting an integration, or making a financial, legal, or other external commitment requires explicit owner confirmation and a typed application action.
- Telegram voice messages are sent transiently to the separately configured STT provider for transcription. STT uses `STT_API_KEY` and `STT_BASE_URL` only; it does not inherit the LLM credentials. Audio is not written to disk or retained by this application. Transport identifiers do not enter assistant projections, typed records, audits, or aggregates.

## What this document does not decide

- Which business process applies to a request. The product agent chooses from the active process index in the same turn.
- Whether a requested mutation or external action is valid. The relevant typed use-case and confirmation policy decide that.
- Legal retention, export, deletion, or provider-contract behavior. Those belong to the future external privacy contour.
