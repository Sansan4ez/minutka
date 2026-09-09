# /bin — typed tool/action manifests

This README is developer documentation, not prompt input or a capability source. The machine-readable catalog is `/bin/registry.json`; the actual capability set is the request-scoped typed tools wired by the application.

`/bin` describes typed application actions, not arbitrary shell commands. A tool or process id never grants additional authority by itself. The registry classifies every live manifest into three explicit categories: `personalAssistant` is the complete model-visible pilot catalog and must exactly match Mastra `toolsets` and `activeTools`; `applicationPlane` documents application-bound operations unavailable to the main agent directly; `disabledForMinutka` preserves inherited operations outside the product boundary.

## Active «Минутка» tools

| Tool manifest | Runtime id | Mutating | Owner scope | Purpose |
|---|---|---:|---|---|
| `/bin/list-schedules.md` | `listSchedules` | No | Authenticated employee | Show only the morning, evening, and weekly message times. |
| `/bin/set-daily-schedule.md` | `setDailySchedule` | Yes, reversible | Authenticated employee and closed morning/evening/weekly ids | Move or re-enable the morning, evening, or weekly message. Arbitrary reminders are not accepted by the agent-facing schema. |
| `/bin/disable-schedule.md` | `disableSchedule` | Yes, reversible | Authenticated employee and exact visible id | Switch off the morning, evening, or weekly message without deleting delivery history. |
| `/bin/process-current-activity-turn.md` | `processCurrentActivityTurn` | Potentially: canonical collect or revisioned repair | Current authenticated employee request; identity, tenant scope, raw text, facets, candidates, handles and revisions are application-bound | Select only `record` or `repair`, run one bounded activity transaction, and return a compact typed outcome before the main agent answers. |
| `/bin/read-weekly-activities.md` | `readWeeklyActivities` | No | Authenticated employee | Return counted active own activities of the last seven days for the weekly summary; no free text and no other participant's data. |
| `/bin/read-cycle-activities.md` | `readCycleActivities` | No | Authenticated employee | Return counted own activities of the training group's cycle for the final personal report, with the values confirmed as repeated; no free text and no other participant's data. |
| `/bin/update-personal-context.md` | `updatePersonalContext` | Yes, employee-only profile write | Authenticated employee | Save explicitly requested or confirmed profile context; activity recording is not confirmation and no target employee id is accepted. |
| `/bin/mark-process-used.md` | `markProcessUsed` | No | Request-scoped closed active process catalog | Record diagnostic evidence for an inline process; grants no capability. |

Schedule changes are level 0 reversible internal writes. Employee-facing replies use product language—morning, evening, or weekly message—and never advertise arbitrary reminders or runtime ids.

Deterministic transport/application actions required for onboarding, consent, reporting, feedback, and personal-data deletion are not agent tools. They continue through authenticated typed use-cases outside the model tool loop. A chat URL follows the capture path as ordinary text: no registered assistant tool fetches, downloads, snapshots, extracts metadata from, or promotes the URL.

## Application-plane manifests

These manifests document typed operations used behind the request-bound `processCurrentActivityTurn` transaction. Their identity, evidence, duration references, candidate handles, and revisions are bound or selected by application/extractor code. They are listed under `applicationPlane`, are not included in `activeTools` or a Mastra toolset, and cannot be called directly by the main agent:

- `/bin/collect-activities.md` — canonical structured activity writes;
- `/bin/read-recent-own-activities.md` — bounded candidate lookup for repair;
- `/bin/correct-recent-activity.md` — revisioned closed-facet correction;
- `/bin/supersede-recent-activity.md` — revisioned explicit duplicate/replacement repair.

## Manifests outside the «Минутка» product boundary

The inherited manifests below stay in the repository for transport/operator compatibility and post-pilot cleanup, but are listed only under `disabledForMinutka` and are wired into no runtime toolset:

- idea inbox and projects: `captureIdea`, `searchIdeas`, `appendIdea`, `proposeIdeaDeletion`, `undoIdeaDeletion`, `listProjects`;
- tasks and idea-to-task conversion: `listTasks`, `proposeTaskMutation`, `proposeIdeaToTask`, `undoTaskMutation`;
- generic knowledge-base access and mutations: `listDocuments`, `readDocument`, `searchDocuments`, `createContextNote`, `proposeContextDocumentUpdate`, `proposeContextDocumentMove`, `proposeContextDocumentDelete`.

Their owning disabled processes are declared in `/processes/disabled-registry.json`. Keeping the lower-level stores or operator use-cases does not make these capabilities model-visible.
