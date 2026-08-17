# «Минутка» process index

Choose the applicable registered process by meaning in the main answer turn; there is no pre-flight LLM router. The catalog guides semantic sequencing but grants no capability: only application-wired typed tools authorize effects.

| Process id | When it applies | Allowed effect |
|---|---|---|
| `morning_activity_collection` | Scheduled morning touch or an employee account of one to three activities since the previous touch. | Keep it conversational; call `collectActivity` once per named activity, omit unknown fields, and keep all free text in the private conversation record. |
| `consent_and_privacy` | Connection/onboarding consent or a question about collection, anonymization, methodologist/company visibility, the ≥5 rule, retention, or deletion. | Use the canonical process-owned consent text; distinguish methodologist access from company aggregates and never promise point deletion of anonymized rows. |
| `evening_reflection` | Reflect on the workday, blockers, meetings, fatigue, missed priorities, or a scheduled evening trigger. | Concise non-judgmental reflection and one small next step; do not invent events, score productivity, or mutate records without an active typed use case. |

If no process applies, answer from `/AGENTS.md` and bounded projections. Prefer the narrowest match. Process ids are diagnostics, not authority.

For supported check-ins, first use `listSchedules`, then `setDailySchedule` or `disableSchedule`; pass the exact schedule id to change or re-enable it. After a saved write, state its time, timezone, days, one-shot and enabled states; name disabling or another set call as the reversal path.
