# /bin — typed tool/action manifests

This README is developer documentation, not prompt input or a capability source. The machine-readable catalog is `/bin/registry.json`; the actual capability set is the request-scoped typed tools wired by the application.

`/bin` describes typed application actions, not arbitrary shell commands. A tool or process id never grants additional authority by itself. The `personalAssistant` registry is the complete model-visible pilot catalog and must exactly match Mastra `toolsets` and `activeTools`.

## Active «Минутка» tools

| Tool manifest | Runtime id | Mutating | Owner scope | Purpose |
|---|---|---:|---|---|
| `/bin/list-schedules.md` | `listSchedules` | No | Authenticated employee | Show only the morning and evening message times. |
| `/bin/set-daily-schedule.md` | `setDailySchedule` | Yes, reversible | Authenticated employee and closed morning/evening ids | Move or re-enable the morning or evening message. Arbitrary reminders are not accepted by the agent-facing schema. |
| `/bin/disable-schedule.md` | `disableSchedule` | Yes, reversible | Authenticated employee and exact visible id | Switch off the morning or evening message without deleting delivery history. |
| `/bin/collect-activity.md` | `collectActivity` | Yes, canonical structured write | Employee and tenant ids bound by `AssistantService` | Record exactly one structured employee activity; omit unknown values and accept no free text. |
| `/bin/update-personal-context.md` | `updatePersonalContext` | Yes, employee-only profile write | Authenticated employee | Save bounded recurring tasks, AI experience, or program goal stated in ordinary conversation; never require them. |
| `/bin/mark-process-used.md` | `markProcessUsed` | No | Request-scoped closed active process catalog | Record diagnostic evidence for an inline process; grants no capability. |

Schedule changes are level 0 reversible internal writes. Employee-facing replies use product language—morning or evening message—and never advertise arbitrary reminders or runtime ids.

Deterministic transport/application actions required for onboarding, consent, reporting, feedback, and personal-data deletion are not agent tools. They continue through authenticated typed use-cases outside the model tool loop. A chat URL follows the capture path as ordinary text: no registered assistant tool fetches, downloads, snapshots, extracts metadata from, or promotes the URL.

## Manifests outside the «Минутка» product boundary

The inherited manifests below stay in the repository for transport/operator compatibility and post-pilot cleanup, but are listed only under `disabledForMinutka` and are wired into no runtime toolset:

- idea inbox and projects: `captureIdea`, `searchIdeas`, `appendIdea`, `proposeIdeaDeletion`, `undoIdeaDeletion`, `listProjects`;
- tasks and idea-to-task conversion: `listTasks`, `proposeTaskMutation`, `proposeIdeaToTask`, `undoTaskMutation`;
- generic knowledge-base access and mutations: `listDocuments`, `readDocument`, `searchDocuments`, `createContextNote`, `proposeContextDocumentUpdate`, `proposeContextDocumentMove`, `proposeContextDocumentDelete`.

Their owning disabled processes are declared in `/processes/disabled-registry.json`. Keeping the lower-level stores or operator use-cases does not make these capabilities model-visible.
