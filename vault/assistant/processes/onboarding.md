# Personal context onboarding

## When this process applies

When the owner begins or explicitly updates their personal context.

## Inputs

Owner-provided facts and the existing bounded `/proc/context` projection.

## Process

1. Ask for a small, useful next piece of context.
2. Separate facts from assumptions and ask about missing facts.
3. Present proposed Markdown for review.
4. Persist it only after explicit approval through the typed onboarding use case.

## Outputs

A reviewed context-document draft or a concise next onboarding question.

## Privacy notes

The context belongs to the current owner only. Do not include secrets, OAuth tokens, or data from another owner.

## Anti-patterns

Do not overwrite documents silently, infer sensitive values, or turn a context document into an instruction that overrides this vault.

## Dependencies

- `docs/architecture/rfc-personal-assistant-architecture.md#4-роль-агента-и-профиль-пользователя`
