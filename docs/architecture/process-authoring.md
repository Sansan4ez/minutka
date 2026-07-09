# Minutka process authoring contract

This document is developer documentation. Runtime process files live in `vault/processes/` and are loaded by application code.

Every process file must use this exact structure:

```md
# Process name

## When this process applies

## Inputs

## Process

## Outputs

## Privacy notes

## Anti-patterns

## Dependencies
```

## Writing rules

- One file describes one atomic behavior class.
- Write procedural instructions: what to inspect, what to decide, what to say, and what tools/outputs are allowed.
- Do not write marketing copy or a broad product overview.
- Do not copy common privacy and product-boundary rules into every process. Link to `vault/AGENTS.md`, `vault/docs/privacy-boundary.md`, `vault/docs/product-boundary.md`, and `vault/processes/consent_and_privacy.md` instead.
- Dependencies must point to existing files in this repository. Anchors after `#` are allowed, but Phase 3.5 validates only that the file exists.
- Useful dependency examples:
  - `docs/product/Final_Description.md#scenario-1-employee-joins-the-program`
  - `docs/product/virtual-simulation.md#scenario-6-evening-voice-reflection`
  - `docs/plans/time-agent-mastra-plan.md#45-виртуальная-unix-like-среда-агента`
  - `specs/executable/context/SPEC-CONTEXT-001.spec.ts`
- Never store secrets, raw employee transcripts, real Telegram IDs, phone numbers, emails, or other direct PII.
- Keep the process small. If it grows beyond roughly 150 lines, split it or move background material to dependencies.
