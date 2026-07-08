# Minutka Agent Manual Lite

Agent Manual is the runtime instruction manual for `MinutkaAgent`. It is not marketing documentation and not a replacement for TypeScript application logic. It contains small procedural business-process files that the application can validate, route through an index-first constrained LLM router, and inject into the agent system context.

## Business processes as code

- A process is an atomic playbook for one behavior class: onboarding, privacy answer, evening reflection, guardrail refusal, insight extraction, or feedback.
- Process files are versioned through ordinary git: pull request, executable specs, commit, tag.
- The manual is loaded once by the application/spec harness and then used by the context builder and constrained router. It must not be read from disk on every chat request.
- Product scenarios in `docs/product/*` are requirement sources. Process files rewrite those scenarios as short procedural instructions instead of copying large fragments.

## Runtime mapping

- `/AGENTS.md` means `core.md` plus selected process files.
- `/docs` means product docs, plans, policy docs, and this manual.
- `/proc` means sanitized application state: profile, consent, thread context, policy, insights, feedback state.
- `/bin` means typed application use cases and tools, not arbitrary shell commands.

These handles are logical contracts in Phase 3.5, not real root directories and not a filesystem runtime.

## Change lifecycle

1. Change or add one process file under `docs/agent-manual/processes/`.
2. Update `registry.json` and `processes/index.md`.
3. Update or add executable specs for the behavior and routing.
4. Run `npm run verify`.
5. Commit/review the change through git.

## Files

- `core.md` — role, global boundaries, privacy baseline, virtual namespace.
- `author-contract.md` — required process-file structure and writing rules.
- `registry.json` — machine-readable process list, paths, appliesTo values, dependencies.
- `processes/index.md` — human-readable process catalogue, boundaries, and file-first routing map.
