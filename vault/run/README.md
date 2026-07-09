# /run — audit and action traces

`/run` is the agent-facing projection of runtime events and action traces.

Static files under `vault/run` define the contract only. Runtime values come from application events and audit storage.

Typical projected traces:

- `ChatMessageReceived`
- `ChatResponseGenerated`
- `WorkBoundaryApplied`
- `InsightRecorded`
- `AgentManualLoadFailed`
- future feedback/action events

Use `/run` to explain what happened, debug decisions, or prepare audits. Do not use `/run` as policy and do not store raw personal transcript data in git.
