# Privacy boundary

This document describes the current prototype-facing privacy explanation. Full personal-data policy, retention, export, deletion, legal controls, and data processing agreements are a future external contour.

## Current explanation

- Employee dialogue is personal context.
- Company and methodologist views must not expose raw conversations, individual tasks, or individual emotional states.
- Structured insights should be short business signals, linked to source ids for audit/correction, and should not copy raw transcript text.
- Aggregate views require safe grouping; the current product baseline uses a minimum group size of 5 employees.
- Telegram voice messages are sent transiently to the separately configured external STT provider (currently OpenAI/Whisper) for transcription. STT uses `STT_API_KEY` and `STT_BASE_URL` only; it never inherits the LLM `OPENAI_API_KEY` or `OPENAI_BASE_URL`. Audio is not written to disk or stored. The bot shows the resulting transcript to the employee, then stores it only as the ordinary private user message in the canonical conversation history; it is not copied into audits, insights, or aggregates. Transport identifiers (file IDs, URLs, duration, size, and MIME type) do not enter domain events, audits, insights, or aggregates.

## What this document does not decide

- Whether a work request is in scope. Use `workday_guardrails` for that.
- Whether a turn is an insight candidate. Use `insight_extraction` selected by the conversation decision router.
- Legal retention/export/deletion behavior. That belongs to the future external privacy contour.
