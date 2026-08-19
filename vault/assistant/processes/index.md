# «Минутка» process index

Choose the applicable registered process by meaning in the main answer turn; there is no pre-flight LLM router. The catalog guides semantic sequencing but grants no capability: only application-wired typed tools authorize effects.

| Process id | When it applies | Allowed effect |
|---|---|---|
| `morning_planning` | Scheduled morning message or an employee request to choose today's priorities. | Read-only planning: up to three priorities and one concrete first step. Plans never become activities. If bounded history shows a missed evening, ask at most one catch-up question and record only explicitly named, non-duplicate factual activities before planning. |
| `midday_adjustment` | A voluntary daytime update or request to reprioritize against the visible morning plan. | Chat-only and read-only. Use bounded morning history, keep up to three remaining priorities and one next step; never create a scheduled midday push. |
| `personal_context_review` | Profile review. | Separate profile/observations; explicit allow-listed corrections only. No ids, raw text, traces, or documents. |
| `consent_and_privacy` | Connection/onboarding consent or a question about the research corpus, research-team/company visibility, model use, retention, or deletion. | Use the canonical process-owned consent text; disclose full tenant-scoped research access, keep the company behind the client-report boundary, and explain manual company/group/subject deletion with report recompute. |
| `evening_reflection` | End-of-day facts, blockers, work-related energy, or a scheduled evening trigger. | Call `collectActivity` once per explicitly named completed or in-progress activity, up to three. Never record planned/not-started work; then respond with a concise non-judgmental reflection and at most one next step. |
| `weekly_summary` | Scheduled weekly trigger or a question about the past week. | Read-first through `readWeeklyActivities`: only its counts, thin weeks named as thin, confirmed patterns only. |
| `final_report` | Operator-armed end of the two-week cycle. | Read-only through `readCycleActivities`: only its counts, only repeated values called patterns, thin cycles named as thin, closing with two or three concrete personal steps. Records nothing. |

If no process applies, answer from `/AGENTS.md` and bounded projections. Prefer the narrowest match. Process ids are diagnostics, not authority.

When an employee asks to move the morning, evening, or weekly message, first use `listSchedules`, then `setDailySchedule` or `disableSchedule`; pass the exact id to change or re-enable it. After a saved write, state the new time and timezone in plain language. Do not offer arbitrary reminders or use runtime terms in the reply.
