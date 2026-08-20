# Morning planning

## When this process applies

Use for the scheduled morning message or when an employee asks to choose priorities for today. It may also handle one short catch-up about yesterday when recent bounded history shows no completed evening reflection.

## Inputs

- `/proc/profile`: the employee's optional role and bounded personal working context.
- `/proc/thread`: bounded recent turns, including yesterday's evening exchange and today's planning conversation.
- Current employee text, or the trusted scheduled `morning_planning` instruction.

## Process

1. Call `markProcessUsed({ id: "morning_planning" })` once.
2. For a scheduled trigger without a fresh answer, invite the employee to name up to three priorities or intentions for today and choose one concrete first step. Keep it one compact Telegram-friendly question.
3. Never call `collectActivities` for a plan, intention, future task, or work that has not started. Planning is read-only for plans; the cross-cutting activity rule still applies.
4. If bounded history shows that yesterday's evening reflection was missed, add at most one short catch-up question before planning: ask whether the employee wants to name activities they actually did or started yesterday. Do not infer a missed reflection from silence outside the available history.
5. When the employee explicitly names factual completed or in-progress activities—yesterday's work in catch-up or today's work in any morning turn—call `collectActivities` once with one array item per named activity. Never record planned or not-started work. Omit unknown closed fields and never pass free text.
6. Before any morning write, inspect bounded history. Do not write an activity already acknowledged as recorded in an earlier turn. If duplication cannot be ruled out, ask a short clarifying question or continue to today's plan without writing.
7. After any catch-up or today's factual write, return to today's plan. Help narrow the answer to at most three priorities and one practical first step. Do not invent deadlines, projects, dependencies, or relative importance.
8. Do not use task, project, idea, document, or reminder tools. Optional personal profile context may inform wording but missing context never blocks planning.

## Outputs

A concise plan with no more than three priorities and exactly one practical next step when the employee supplied enough information. A scheduled prompt may combine one optional catch-up question with the planning invitation.

## Privacy notes

Plans remain in private conversation history and research traces; they are not canonical activities. Catch-up activities use the same employee-scoped structured action and closed dictionaries as evening collection.

## Anti-patterns

Recording plans as facts; recreating a task tracker; asking a long questionnaire; inventing yesterday's work; repeating an already recorded activity; blocking today's plan when the employee skips catch-up.
