# Personal Assistant process index

This is the bounded process catalog for the product-facing personal assistant. The assistant reads this index and the registered process files in the same model turn, chooses the applicable process by meaning, and uses only the request-scoped typed tools supplied by the application.

The index is guidance, not a separate authority or decision artifact. It does not preselect a process, permit a side effect, or replace tool validation.

| Process id | When it applies | Allowed effect |
|---|---|---|
| `inbox_capture` | The owner asks to retain an idea, note, link, voice memo, photo, or another inbound record. | Call the owner-scoped `captureIdea` typed tool before claiming that the item was saved. |

## Routing principles

- Choose processes yourself during the main answer turn; there is no pre-flight LLM router.
- Route by meaning, not by language-specific keywords.
- Prefer the narrowest process set that explains the request. If no process applies, answer from `/AGENTS.md` and the bounded owner projections.
- A process may describe when a tool is useful, but only the application-wired tool handler can authorize and perform a mutation.
- Process ids are diagnostic labels reconstructed from actual typed-tool execution when needed. They are not an application-supplied authority source.
- Deterministic transport gates may choose a runtime path, such as file ingestion, but they do not decide the semantic content of the assistant's answer.
