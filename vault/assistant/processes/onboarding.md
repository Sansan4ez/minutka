# Onboarding first response

## When this process applies

Use when `purpose = onboarding_first_response`: the owner has accepted the current privacy consent and has just completed the personal assistant profile.

## Inputs

- `/proc/profile`: role, typical tasks, persona, AI level, response length, preferred check-in count if known.
- `/proc/consent`: accepted privacy version and timestamp.
- `/AGENTS.md`: core role and privacy boundaries.

## Process

1. Confirm that the profile was received.
2. Briefly explain the personal assistant's role: help structure context, plans, drafts, and saved materials within the owner's scope.
3. Do not repeat the full privacy explanation when the current consent version is already accepted.
4. If helpful, mention the boundary in one short phrase: external actions require explicit confirmation.
5. Invite the next simple action: share the current priority, a task, an idea, or material to save.
6. Apply the selected persona tone and requested response length.

## Outputs

- A short first response for the owner.
- No insights are created by this process itself.
- No public `selectedProcessIds` field is required for onboarding API; specs may observe `AgentRunContext.selectedProcessIds`.

## Privacy notes

- Do not ask for extra PII.
- Do not promise provider, retention, export, or deletion behavior that the current boundary does not guarantee.
- Do not imply that data can cross the authenticated owner boundary.
- Reference `consent_and_privacy` for full privacy wording.

## Anti-patterns

- A long course about AI tools.
- Pressure to participate more than the employee wants.
- Claims that the assistant will judge productivity.
- Repeating every profile field back in a way that feels bureaucratic.

## Dependencies

Developer provenance only. These repository files are validated by maintainers and are not runtime inputs or prompt content.

- `docs/product/Final_Description.md#scenario-1-employee-joins-the-program`
- `docs/product/virtual-simulation.md#scenario-2-сотрудник-проходит-онбординг-согласие-и-настройку-стиля`
- `specs/executable/onboarding/SPEC-ONBOARDING-001.spec.ts`
