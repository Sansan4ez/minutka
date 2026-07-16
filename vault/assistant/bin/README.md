# /bin — typed tool/action manifests

`/bin` describes typed application actions available to agent runtimes. These are not arbitrary shell commands.

The product-facing personal assistant chooses applicable `/processes` itself in the main turn. Tools remain mechanical: the request-scoped application handler validates input, binds owner scope, performs the side effect, and records audit data. A tool or process id never grants additional authority by itself.

The machine-readable registry is `/bin/registry.json`; executable specs keep it aligned with the request-scoped Mastra toolset.

| Tool manifest | Runtime | Mutating | Purpose |
|---|---|---:|---|
| `/bin/capture-idea.md` (`captureIdea`) | Personal assistant | Yes | Save a classified owner idea through `IngestionService`. |
| `/bin/list-documents.md` (`listDocuments`) | Personal assistant | No | List bounded logical document metadata under `/proc/context`. |
| `/bin/read-document.md` (`readDocument`) | Personal assistant | No | Read a bounded document range or Markdown section. |
| `/bin/search-documents.md` (`searchDocuments`) | Personal assistant | No | Search owner document paths/content with bounded snippets. |
| `/bin/route-conversation-decision.md` | Legacy Minutka compatibility | No | Produce the legacy work/insight decision while that path remains. |
| `/bin/extract-insights.md` | Legacy Minutka compatibility | Yes | Persist structured insight drafts after an allowed response. |
| `/bin/update-profile.md` | Identity/onboarding compatibility | Yes | Save onboarding/profile fields through application validation. |
| `/bin/record-feedback.md` | Identity/onboarding compatibility | Yes | Record employee feedback about a previous answer. |
