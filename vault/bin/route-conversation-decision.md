# /bin/route-conversation-decision

## Purpose

Return a constrained conversation decision for the current turn.

## Mutating

No.

## Input

- current text
- purpose
- selected employee profile fields
- recent thread context
- `/processes/index.md`
- process registry

## Output

Strict JSON equivalent to `ConversationDecision`:

- `selectedProcessIds`
- `workDecision`
- `insightDecision`

## Rules

- Select only process ids allowed by `/processes/registry.json`.
- Route by semantic fit, not language-specific keyword rules.
- Do not call the main Minutka answer chain.
- Do not persist insights or feedback.
