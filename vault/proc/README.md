# /proc — sanitized runtime state projection

`/proc` is the agent-facing projection of current application state. It is not the physical storage location for personal data.

Static files under `vault/proc` define schemas and projection contracts. Runtime values come from application storage such as profile store, conversation memory, insight store, feedback store, or future database tables.

## Projected families

| Path | Source | Meaning |
|---|---|---|
| `/proc/profile` | Profile store | Selected employee profile fields needed for tone/context. |
| `/proc/consent` | Consent/onboarding state | Current consent status/version. |
| `/proc/thread` | Conversation memory | Recent sanitized turns. |
| `/proc/decision` | ConversationDecisionRouter | Selected processes and work/insight decisions for current turn. |
| `/proc/insights` | Insight store | Recent structured signals, not raw transcript. |
| `/proc/feedback` | Feedback store | Previous-answer quality feedback. |

Do not commit raw employee messages, real personal identifiers, or production state into `vault/proc`.
