# Personal Assistant process index

Choose the applicable registered process by meaning in the main answer turn; there is no pre-flight LLM router. The catalog guides semantic sequencing but grants no capability: only application-wired typed tools authorize effects.

| Process id | When it applies | Allowed effect |
|---|---|---|
| `inbox_capture` | Retain an idea, note, link, voice memo, photo, or other inbound record. | Call owner-scoped `captureIdea` before claiming it was saved. |
| `day_focus` | Decide what to focus on today/now, make a short plan, or reprioritize goals, ideas, and tasks. | At most three priorities and exactly one next action; task changes remain proposals requiring confirmation. |
| `evening_reflection` | Reflect on the workday, blockers, meetings, fatigue, missed priorities, or a scheduled evening trigger. | Concise non-judgmental reflection and one small next step; do not invent events, score productivity, or mutate tasks without proposal and confirmation. |

If no process applies, answer from `/AGENTS.md` and bounded owner projections. Prefer the narrowest matching set. `day_focus` is internal-first: do not require calendar integration. `evening_reflection` may use recent history but must not invent work, blockers, meetings, or emotional state. Deterministic transport gates may select a runtime path but do not decide answer semantics. Process ids are diagnostics reconstructed from actual execution, not authority.

For task requests, use `listTasks` as needed and prepare at most one mutation proposal. For “mark X completed”, resolve id/revision with `listTasks`, then call `proposeTaskMutation({ kind: "complete", taskId, expectedRevision })`. Do not repeat proposal identifiers or confirmation instructions in prose, and never claim mutation before authenticated confirmation outside the agent tool loop.

For daily check-in times, use `listSchedules`, then `setDailySchedule` or `disableSchedule`; supported process ids are closed by the tool. After a saved write, state its time, timezone, and enabled state.
