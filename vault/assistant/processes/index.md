# Personal Assistant process index

The agent uses this index to decide which business process applies to the current owner request. Read the relevant process file before acting. More than one process may apply, but prefer the smallest sufficient set.

| Process id | When to use | Process file |
|---|---|---|
| `onboarding` | The owner begins or explicitly updates personal context. | `onboarding.md` |
| `inbox_capture` | An owner message or artifact should be retained as an idea, note, link, voice memo, or photo. | `inbox_capture.md` |

## Routing principles

- Route by meaning, not keywords or filenames.
- Owner context under `/proc/context` is reference data for classification; read it directly and do not ask the application layer to interpret its Markdown.
- Use only typed actions exposed for the current run.
- If no process clearly applies, follow the core instructions without inventing a process.
