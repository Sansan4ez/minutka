# /bin — typed tool/action manifests

This README is developer documentation, not prompt input or a capability source. The machine-readable catalog is `/bin/registry.json`; the actual capability set is the request-scoped typed tools wired by the application.

`/bin` describes typed application actions available to agent runtimes. These are not arbitrary shell commands.

The product-facing personal assistant chooses applicable `/processes` itself in the main turn. Tools remain mechanical: the request-scoped application handler validates input, binds owner scope, performs the side effect, and records audit data. A tool or process id never grants additional authority by itself.

The machine-readable registry is `/bin/registry.json`; executable specs keep it aligned with the request-scoped Mastra `toolsets` and `activeTools`. The registry is the complete active capability catalog, not a compatibility inventory.

| Tool manifest | Runtime id | Mutating | Confirmation | Owner scope | Purpose |
|---|---|---:|---|---|---|
| `/bin/capture-idea.md` | `captureIdea` | Yes, reversible internal write | No | Bound by `AssistantService`; owner id is not model input | Save a classified owner idea through `IngestionService`. |
| `/bin/list-documents.md` | `listDocuments` | No | No | Authenticated owner's `/proc/context` only | List bounded logical document metadata. |
| `/bin/read-document.md` | `readDocument` | No | No | Authenticated owner's `/proc/context` only | Read a bounded document range or Markdown section. |
| `/bin/search-documents.md` | `searchDocuments` | No | No | Authenticated owner's `/proc/context` only | Search owner document paths/content with bounded snippets. |
| `/bin/list-tasks.md` | `listTasks` | No | No | Authenticated owner's tasks only | List bounded tasks and current revisions. |
| `/bin/propose-task-mutation.md` | `proposeTaskMutation` | No durable mutation | Produces confirmation | Owner bound by `AssistantService`; task id is application-generated | Propose create/update/complete/cancel. |
| `/bin/propose-idea-to-task.md` | `proposeIdeaToTask` | No durable mutation | Produces confirmation | Owner and provenance bound by application use-case | Propose an idempotent idea-to-task conversion. |
| `/bin/confirm-task-mutation.md` | `confirmTaskMutation` | Yes | Requires exact pending confirmation | Owner bound by `AssistantService` | Execute once or return the stable stored outcome. |

Read, list, and search are tools because they are deterministic typed operations over an owner-scoped namespace. `inbox_capture` is a business process because the agent must interpret the inbound item, choose its project and record type, decide whether clarification is needed, and then invoke `captureIdea`.

Deterministic transport/application actions such as consent callbacks, onboarding confirmation, and feedback rating persistence are not agent tools unless they are explicitly wired into the request-scoped runtime. In particular, feedback callbacks call `submitFeedback` directly and do not claim an agent-process execution.
