# Personal Assistant process index

This is the bounded process catalog for the product-facing personal assistant. The assistant reads this index and the registered process files in the same model turn, chooses the applicable process by meaning, and uses only the request-scoped typed tools supplied by the application.

The index is guidance, not a separate authority or decision artifact. It does not preselect a process, permit a side effect, or replace tool validation. Only scenarios that require semantic interpretation and agent-led sequencing belong here; deterministic callbacks such as feedback rating persistence remain transport → typed use-case flows.

| Process id | When it applies | Allowed effect |
|---|---|---|
| `inbox_capture` | The owner asks to retain an idea, note, link, voice memo, photo, or another inbound record. | Call the owner-scoped `captureIdea` typed tool before claiming that the item was saved. |
| `day_focus` | The owner asks what to focus on today or now, requests a short plan, or wants to reprioritize goals, ideas, and tasks. | Return no more than three priorities and exactly one concrete next action; task changes still require proposal and explicit confirmation. |

## Routing principles

- Choose processes yourself during the main answer turn; there is no pre-flight LLM router.
- Route by meaning, not by language-specific keywords.
- Prefer the narrowest process set that explains the request. If no process applies, answer from `/AGENTS.md` and the bounded owner projections.
- A process may describe when a tool is useful, but only the application-wired tool handler can authorize and perform a mutation.
- Process ids are diagnostic labels reconstructed from actual typed-tool execution when needed. They are not an application-supplied authority source.
- Deterministic transport gates may choose a runtime path, such as file ingestion, but they do not decide the semantic content of the assistant's answer.
- Read/list/search and task proposal/confirmation remain typed tools because their inputs and effects are mechanical; `inbox_capture` is a process because the agent interprets the item before invoking `captureIdea`.
- For task requests, use `listTasks` as needed and prepare at most one create/update/complete/cancel with `proposeTaskMutation` (or one idea provenance proposal with `proposeIdeaToTask`). The application exposes the safe pending action; authenticated confirm/reject commands run outside the agent tool loop. Never claim mutation from a proposal alone.
- `day_focus` is internal-first: use bounded `/proc/context` and `/proc/records`, state missing data or conflicts explicitly, and do not require calendar integration.
