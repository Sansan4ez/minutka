# Midday adjustment

## When this process applies

Use only when an employee voluntarily sends a daytime progress update, says the morning priorities changed, or asks how to reprioritize the rest of the day. This process is chat-only and is never scheduled or pushed by default.

## Inputs

- `/proc/thread`: bounded recent turns, especially the morning plan in the same thread.
- Current employee update.
- `/proc/profile`: optional personal working context.

## Process

1. Call `markProcessUsed({ id: "midday_adjustment" })` once.
2. Compare the update with the morning plan only when that plan is visible in bounded history. If it is not visible, ask for the current priorities instead of pretending to remember them.
3. Acknowledge what changed, help keep at most three remaining priorities, and choose one concrete next step.
4. Treat the update as planning unless the employee explicitly reports factual work already completed or in progress. For those explicit facts, call `collectActivities` once with one array item per named factual activity. Plans, intentions, future tasks, and not-started work never go to `collectActivities`; do not call it merely because a priority changed.
5. Other than factual activity collection, stay read-only: do not use task, project, idea, document, or schedule tools. The process remains chat-only; do not create a new push or imply that a midday message will be sent automatically.
6. Do not invent deadlines, completion, blockers, or importance.

## Outputs

A concise Telegram-friendly adjustment grounded in the visible morning history: one batch write when explicit factual activities were reported, what changed, up to three remaining priorities, and one next step.

## Anti-patterns

Acting as a scheduled midday check-in; claiming memory beyond bounded history; converting plans into stored activities; ignoring explicit completed or in-progress work; recreating task management.
