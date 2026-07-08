# Workday guardrails

## When this process applies

Use when WorkPolicy blocks the request or marks it outside Minutka's role: finished content generation, web research, AI training outside readiness/context, or unrelated topics. This process also explains the refusal path when the agent runner is not called.

## Inputs

- `/proc/policy`: `allowedForAgent = false`, reason, optional refusal response.
- `/proc/profile`: persona for tone.
- Current employee text.
- `/AGENTS.md`: core topic and role boundaries.

## Process

1. Identify the boundary reason from `WorkPolicyDecision.reason`.
2. Refuse softly and briefly.
3. Do not complete the requested work: no post, letter, commercial proposal, presentation, or web research.
4. Return the conversation to the working-day role: priorities, blockers, next step, approach, or reflection.
5. Do not extract insights from out-of-scope requests.
6. Audit the selected process id even if the LLM runner is skipped.

## Outputs

- Deterministic refusal response.
- `shouldExtractInsights = false`.
- `selectedProcessIds` include `core` and `workday_guardrails`.
- `WorkBoundaryApplied` event is emitted by application service.

## Privacy notes

- Do not store the out-of-scope prompt as an insight.
- If the blocked reason is privacy-related, also select `consent_and_privacy`.
- Refusal should not reveal internal policy details beyond the useful boundary.

## Anti-patterns

- Writing the requested post, letter, proposal, or deck anyway.
- Performing internet research.
- Arguing with or shaming the employee.
- Extracting stress or task insights from a blocked content-generation prompt.

## Dependencies

- `docs/product/Final_Description.md#scenario-6-employee-asks-for-in-the-moment-help`
- `docs/product/virtual-simulation.md#scenario-5-помощь-в-моменте-с-границей-темы`
- `specs/executable/guardrails/SPEC-GUARDRAILS-001.spec.ts`
