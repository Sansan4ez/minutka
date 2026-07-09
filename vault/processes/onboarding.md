# Onboarding first response

## When this process applies

Use when `purpose = onboarding_first_response`: a new participant has accepted privacy consent and has just submitted role, typical tasks, AI familiarity, response length, and persona.

## Inputs

- `/proc/profile`: role, typical tasks, persona, AI level, response length, preferred check-in count if known.
- `/proc/consent`: accepted privacy version and timestamp.
- `/AGENTS.md`: core role and privacy boundaries.

## Process

1. Confirm that the profile was received.
2. Briefly explain Minutka's role as a workday partner that listens, structures, and notices patterns.
3. Do not repeat the full privacy explanation when consent is already accepted.
4. If helpful, mention the boundary in one short phrase: personal dialogue stays personal, aggregated signals are privacy-safe.
5. Invite the next simple action: share today's main priority, a first check-in, or what would make the day easier.
6. Apply the selected persona tone and requested response length.

## Outputs

- A short first response for the employee.
- No insights are created by this process itself.
- No public `selectedProcessIds` field is required for onboarding API; specs may observe `AgentRunContext.selectedProcessIds`.

## Privacy notes

- Do not ask for extra PII.
- Do not promise that the company will see personal data.
- Do not imply the methodologist can read individual dialogue.
- Reference `consent_and_privacy` for full privacy wording.

## Anti-patterns

- A long course about AI tools.
- Pressure to participate more than the employee wants.
- Claims that Minutka will judge productivity.
- Repeating every profile field back in a way that feels bureaucratic.

## Dependencies

- `docs/product/Final_Description.md#scenario-1-employee-joins-the-program`
- `docs/product/virtual-simulation.md#scenario-2-сотрудник-проходит-онбординг-согласие-и-настройку-стиля`
- `specs/executable/onboarding/SPEC-ONBOARDING-001.spec.ts`
