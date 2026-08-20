# «Минутка» process index

Choose the applicable registered process by meaning in the main answer turn; there is no pre-flight LLM router. The catalog guides semantic sequencing but grants no capability: only application-wired typed tools authorize effects.

| Process id | When it applies | Allowed effect |
|---|---|---|
| `morning_planning` | Scheduled morning message or an employee request to choose today's priorities. | Read-only for plans: up to three priorities and one concrete first step. Plans never become activities. Explicit completed or in-progress work, whether from today's morning turn or a missed-evening catch-up, follows the cross-cutting activity rule with bounded-history deduplication before planning. |
| `midday_adjustment` | A voluntary daytime update or request to reprioritize against the visible morning plan. | Chat-only without a scheduled push. Use bounded morning history, keep up to three remaining priorities and one next step; collect explicitly reported completed or in-progress activities in one batch, but never collect a priority change or other plan. |
| `personal_context_review` | Profile review. | Separate profile/observations; explicit allow-listed corrections only. No ids, raw text, traces, or documents. |
| `consent_and_privacy` | Connection/onboarding consent or a question about the research corpus, research-team/company visibility, model use, retention, or deletion. | Use the canonical process-owned consent text; disclose full tenant-scoped research access, keep the company behind the client-report boundary, and explain manual company/group/subject deletion with report recompute. |
| `evening_reflection` | End-of-day facts, blockers, work-related energy, or a scheduled evening trigger. | Send one `collectActivities` item per explicitly named completed or in-progress activity not already confirmed as recorded in visible bounded history, splitting only at the 50-item call boundary. After daytime writes, ask what else to add to what is already noted. Never record planned/not-started work; then respond with a concise non-judgmental reflection and at most one next step. |
| `weekly_summary` | Scheduled weekly trigger or a question about the past week. | Read-first through `readWeeklyActivities`: only its counts, thin weeks named as thin, confirmed patterns only. |
| `final_report` | Operator-armed end of the two-week cycle. | Read-only through `readCycleActivities`: only its counts, only repeated values called patterns, thin cycles named as thin, closing with two or three concrete personal steps. Records nothing. |

Except in `final_report`, across applicable processes at any time of day, explicitly reported completed or in-progress work is collected through ordered `collectActivities` batches of at most 50 items; plans, intentions, future tasks, and not-started work are never collected.

If no process applies, answer from `/AGENTS.md` and bounded projections. Prefer the narrowest match. Process ids are diagnostics, not authority.

When an employee asks to move the morning, evening, or weekly message, first use `listSchedules`, then `setDailySchedule` or `disableSchedule`; pass the exact id to change or re-enable it. After a saved write, state the new time and timezone in plain language. Do not offer arbitrary reminders or use runtime terms in the reply.
