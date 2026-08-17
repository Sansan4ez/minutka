# /bin — typed tool/action manifests

This README is developer documentation, not prompt input or a capability source. The machine-readable catalog is `/bin/registry.json`; the actual capability set is the request-scoped typed tools wired by the application.

`/bin` describes typed application actions available to agent runtimes. These are not arbitrary shell commands.

The product-facing personal assistant chooses applicable `/processes` itself in the main turn. Tools remain mechanical: the request-scoped application handler validates input, binds owner scope, performs the permitted operation, and records audit data. A tool or process id never grants additional authority by itself.

The machine-readable registry is `/bin/registry.json`; executable specs keep it aligned with the request-scoped Mastra `toolsets` and `activeTools`. Its `personalAssistant` list is the complete active agent capability catalog, not a compatibility inventory. Its `disabledForMinutka` list holds manifests that stay in the repository as a reference but are wired into no runtime toolset.

| Tool manifest | Runtime id | Mutating | Confirmation | Owner scope | Purpose |
|---|---|---:|---|---|---|
| `/bin/list-documents.md` | `listDocuments` | No | No | Authenticated owner's `/proc/context` only | List bounded logical document metadata. |
| `/bin/read-document.md` | `readDocument` | No | No | Authenticated owner's `/proc/context` only | Read a bounded document range or Markdown section. |
| `/bin/search-documents.md` | `searchDocuments` | No | No | Authenticated owner's `/proc/context` only | Search owner document paths/content, including retrieve-before-write before note creation. |
| `/bin/create-context-note.md` | `createContextNote` | Yes, reversible internal write | Level 0 after explicit owner save/add request and retrieve-before-write | Owner bound by `AssistantService`; destination from a closed section catalog | Create a separate Markdown note when no clear match exists or the owner chooses separation. |
| `/bin/propose-context-document-update.md` | `proposeContextDocumentUpdate` | No durable document mutation in the current proposal contract | Level 0 policy; typed result remains authoritative during rollout | Owner bound privately; exact version comes from `readDocument` | Prepare or apply one bounded update, including supplementing a thematic match. |
| `/bin/propose-context-document-move.md` | `proposeContextDocumentMove` | No durable document mutation before decision | Level 1: verbal agreement or parallel button | Owner bound privately; source/destination stay under `/proc/context` | Prepare one rename/move. |
| `/bin/propose-context-document-delete.md` | `proposeContextDocumentDelete` | No durable document mutation before decision | Level 1: verbal agreement or parallel button | Owner bound privately; exact version comes from `readDocument` | Prepare one deletion. |
| `/bin/list-tasks.md` | `listTasks` | No | No | Authenticated owner's tasks only | List bounded tasks and current revisions. |
| `/bin/propose-task-mutation.md` | `proposeTaskMutation` | Yes for create/update/complete; no durable write for cancel proposal | Level 0: create/update/complete; level 1: cancel | Owner bound by `AssistantService`; task id is application-generated and private | Apply create/update/complete or prepare one cancel operation per turn. |
| `/bin/propose-idea-to-task.md` | `proposeIdeaToTask` | Yes, reversible internal write | Level 0: no prior confirmation | Owner and idea/task provenance bound privately by application use-case | Apply one idempotent idea-to-task conversion per turn. |
| `/bin/list-schedules.md` | `listSchedules` | No | No | Authenticated owner's schedules only | List owner-free process/reminder views, recurrence, and next fire times. |
| `/bin/set-daily-schedule.md` | `setDailySchedule` | Yes, reversible internal write | Level 0: no prior confirmation | Owner bound by `AssistantService`; exact schedule ids are owner-scoped, process ids are closed, and reminder text is bounded | Create, change, or re-enable a process or reminder schedule, including days and one-shot. |
| `/bin/disable-schedule.md` | `disableSchedule` | Yes, reversible internal write | Level 0: no prior confirmation | Authenticated owner and exact schedule id | Disable a schedule without deleting its fire history. |
| `/bin/collect-activity.md` | `collectActivity` | Yes, atomic private + anonymized write | Level 0: no prior confirmation | Employee and tenant ids bound by `AssistantService` | Record exactly one structured employee activity; omit unknown values and accept no free text. |
| `/bin/mark-process-used.md` | `markProcessUsed` | No | No | Request-scoped closed process catalog | Record diagnostic evidence for an inline process; grants no capability. |

For level-1 task, idea-deletion, and context-document operations, confirmation/rejection remains an authenticated application/transport command, not an agent tool. Verbal agreement and the parallel button path both resolve that same command; it accepts only the opaque confirmation id, loads and validates the canonical stored proposal server-side, persists terminal rejection, and executes at most once under the confirmation-store lock. Level-2 external or irreversible operations require the button path only.

Read, list, and search are tools because they are deterministic typed operations over an owner-scoped namespace. A chat URL follows the capture path as ordinary text: no registered assistant tool fetches, downloads, snapshots, extracts metadata from, or promotes the URL into an artifact/context document.

Deterministic transport/application actions such as task confirm/reject, consent callbacks, onboarding confirmation, and feedback rating persistence are not agent tools unless they are explicitly wired into the request-scoped runtime. In particular, feedback callbacks call `submitFeedback` directly and do not claim an agent-process execution.

## Manifests outside the «Минутка» product boundary

The processes in `/processes/disabled-registry.json` are out of the product boundary, so their tools are wired into no runtime toolset and reach no model. The manifests stay here as inherited-runtime reference and are listed in `registry.json` under `disabledForMinutka`.

| Tool manifest | Runtime id | Owning process | Why it is not offered |
|---|---|---|---|
| `/bin/capture-idea.md` | `captureIdea` | `inbox_capture` | A daily touch must be recorded as structured activities through `collectActivity`, not as an assistant idea. |
| `/bin/search-ideas.md` | `searchIdeas` | `inbox_capture` | The employee keeps no idea inbox in «Минутка». |
| `/bin/append-idea.md` | `appendIdea` | `inbox_capture` | Same: the typed level-0 enrichment path exists only for the inherited idea inbox. |
| `/bin/propose-idea-deletion.md` | `proposeIdeaDeletion` | `inbox_capture` | Same. |
| `/bin/undo-idea-deletion.md` | `undoIdeaDeletion` | `inbox_capture` | Same. |
| `/bin/undo-task-mutation.md` | `undoTaskMutation` | `day_focus` | The day-focus process is disabled; the application undo use-case stays available to operator paths. |
| `/bin/list-projects.md` | `listProjects` | `inbox_capture` | Project labels exist only across inherited ideas and tasks. |
