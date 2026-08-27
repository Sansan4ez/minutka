# `updatePersonalContext`

## Purpose

Save an explicit correction to the authenticated employee's bounded profile, or bounded working context that the employee explicitly asked or confirmed should be saved.

## Mutating

Yes: level-0 employee-scoped profile update.

## Input

Any non-empty subset of the closed field set:

- preferred name;
- communication persona and answer length;
- IANA timezone;
- personal role self-description;
- up to seven concise recurring-task summaries, with an optional `typicalTasksMode`: `append` (default) adds them to the stored list, `replace` makes the stored list exactly the sent list;
- closed AI experience level: `beginner`, `intermediate`, or `advanced`;
- one concise personal goal for the program.

## Output

The names of profile fields that changed. Field values are not returned.

## Rules

- Call only after an explicit request or confirmation. An activity report is not confirmation, and a turn recorded through `processCurrentActivityTurn` must not also update the profile.
- Use only confirmed facts or explicit corrections; never infer missing values or accept a target employee id.
- Do not turn the conversation into a questionnaire or require these fields.
- Summarize rather than copy long free text; application limits remain authoritative.
- Use `replace` only when the employee explicitly asked to drop, rename, or rewrite a recurring task, or when the seven-task limit leaves no room for a task they just stated. Send the whole corrected list in one call: tasks left out are dropped. Never replace to tidy up the list on your own initiative.
- The list cannot be emptied from the conversation: `replace` keeps at least one task. An employee who wants no recurring tasks at all is served by the operator through the profile boundary.
- The values stay in the employee profile and bounded LLM context. They are excluded from participant inventory, audit metadata values, structured activities, and the company report.
- Exact tenant-directory role is displayed by the personal-context read model but changed only by the separate role-directory/onboarding boundary.
