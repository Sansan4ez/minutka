# /bin — typed tool/action manifests

This README is developer documentation, not prompt input or a capability source. The machine-readable catalog is `/bin/registry.json`; the actual capability set is the request-scoped typed tools wired by the application.

`/bin` describes typed application actions available to agent runtimes. These are not arbitrary shell commands.

The product-facing personal assistant chooses applicable `/processes` itself in the main turn. Tools remain mechanical: the request-scoped application handler validates input, binds owner scope, performs the permitted operation, and records audit data. A tool or process id never grants additional authority by itself.

The machine-readable registry is `/bin/registry.json`; executable specs keep it aligned with the request-scoped Mastra `toolsets` and `activeTools`. The registry is the complete active agent capability catalog, not a compatibility inventory.

| Tool manifest | Runtime id | Mutating | Confirmation | Owner scope | Purpose |
|---|---|---:|---|---|---|
| `/bin/capture-idea.md` | `captureIdea` | Yes, reversible internal write | Level 0: no prior confirmation | Bound by `AssistantService`; owner id is not model input | Save a classified owner idea through `IngestionService`. |
| `/bin/search-ideas.md` | `searchIdeas` | No | No | Authenticated owner's active ideas only | Resolve exact or ambiguous deletion candidates with current revisions. |
| `/bin/propose-idea-deletion.md` | `proposeIdeaDeletion` | No durable deletion | Level 1: verbal agreement or parallel button | Owner and exact idea id/revision bound by `AssistantService` | Prepare one reversible idea deletion for authenticated confirmation. |
| `/bin/undo-idea-deletion.md` | `undoIdeaDeletion` | Yes, reversible internal write | Level 0: no prior confirmation | Authenticated owner's tombstones inside the undo window | Restore an exact or most recently deleted idea idempotently. |
| `/bin/list-documents.md` | `listDocuments` | No | No | Authenticated owner's `/proc/context` only | List bounded logical document metadata. |
| `/bin/read-document.md` | `readDocument` | No | No | Authenticated owner's `/proc/context` only | Read a bounded document range or Markdown section. |
| `/bin/search-documents.md` | `searchDocuments` | No | No | Authenticated owner's `/proc/context` only | Search owner document paths/content with bounded snippets. |
| `/bin/create-context-note.md` | `createContextNote` | Yes, reversible internal write | Level 0 after explicit owner save/add request | Owner bound by `AssistantService`; destination from a closed section catalog | Create one new Markdown note and return its `/proc/context/*` path/version. |
| `/bin/propose-context-document-update.md` | `proposeContextDocumentUpdate` | No durable document mutation in the current proposal contract | Level 0 policy; typed result remains authoritative during rollout | Owner bound privately; exact version comes from `readDocument` | Prepare or apply one bounded update. |
| `/bin/propose-context-document-move.md` | `proposeContextDocumentMove` | No durable document mutation before decision | Level 1: verbal agreement or parallel button | Owner bound privately; source/destination stay under `/proc/context` | Prepare one rename/move. |
| `/bin/propose-context-document-delete.md` | `proposeContextDocumentDelete` | No durable document mutation before decision | Level 1: verbal agreement or parallel button | Owner bound privately; exact version comes from `readDocument` | Prepare one deletion. |
| `/bin/list-tasks.md` | `listTasks` | No | No | Authenticated owner's tasks only | List bounded tasks and current revisions. |
| `/bin/propose-task-mutation.md` | `proposeTaskMutation` | Yes for create/update/complete; no durable write for cancel proposal | Level 0: create/update/complete; level 1: cancel | Owner bound by `AssistantService`; task id is application-generated and private | Apply create/update/complete or prepare one cancel operation per turn. |
| `/bin/propose-idea-to-task.md` | `proposeIdeaToTask` | Yes, reversible internal write | Level 0: no prior confirmation | Owner and idea/task provenance bound privately by application use-case | Apply one idempotent idea-to-task conversion per turn. |
| `/bin/undo-task-mutation.md` | `undoTaskMutation` | Yes, reversible internal write | Level 0: no prior confirmation | Latest eligible canonical task mutation of authenticated owner | Restore the previous task/idea state within the undo window. |
| `/bin/list-schedules.md` | `listSchedules` | No | No | Authenticated owner's schedules only | List owner-free daily schedule views and next fire times. |
| `/bin/set-daily-schedule.md` | `setDailySchedule` | Yes, reversible internal write | Level 0: no prior confirmation | Owner bound by `AssistantService`; process id is from a closed catalog | Create, change, or re-enable one daily assistant schedule. |
| `/bin/disable-schedule.md` | `disableSchedule` | Yes, reversible internal write | Level 0: no prior confirmation | Authenticated owner and exact schedule id | Disable a schedule without deleting its fire history. |
| `/bin/mark-process-used.md` | `markProcessUsed` | No | No | Request-scoped closed process catalog | Record diagnostic evidence for an inline read-only process; grants no capability. |

For level-1 task, idea-deletion, and context-document operations, confirmation/rejection remains an authenticated application/transport command, not an agent tool. Verbal agreement and the parallel button path both resolve that same command; it accepts only the opaque confirmation id, loads and validates the canonical stored proposal server-side, persists terminal rejection, and executes at most once under the confirmation-store lock. Level-2 external or irreversible operations require the button path only.

Read, list, and search are tools because they are deterministic typed operations over an owner-scoped namespace. `inbox_capture` is a business process because the agent must interpret the inbound item, choose its project and record type, decide whether clarification is needed, and then invoke `captureIdea`.

Deterministic transport/application actions such as task confirm/reject, consent callbacks, onboarding confirmation, and feedback rating persistence are not agent tools unless they are explicitly wired into the request-scoped runtime. In particular, feedback callbacks call `submitFeedback` directly and do not claim an agent-process execution.
