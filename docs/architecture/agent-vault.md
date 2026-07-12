# Minutka agent vault architecture

## Decision

Minutka runtime instructions, business-process descriptions, active runtime docs, tool manifests, and state projection contracts live in a single logical vault:

```text
vault/
  AGENTS.md
  processes/
  docs/
  bin/
  proc/
  run/
```

This replaces the previous `docs/agent-manual` layout. The previous layout treated runtime agent instructions as project documentation; the vault layout treats them as the agent's working environment.

## Why not `docs/agent-manual`

`docs/` is for project/product/developer documentation: plans, architecture notes, generated reports, and product source docs. Runtime instructions should not be hidden among development docs because they are loaded by application code and affect production behavior.

## Why `vault/AGENTS.md`

`AGENTS.md` is the standard entrypoint pattern for agent instructions. In this repo it is placed under `vault/AGENTS.md`, not repo root, to avoid confusing coding-agent instructions with Minutka runtime instructions.

- repo root `AGENTS.md` if added later: instructions for developers/coding agents;
- `vault/AGENTS.md`: instructions for the Minutka runtime agent.

## Namespace contract

The vault exposes a stable logical namespace:

```text
/AGENTS.md  → vault/AGENTS.md
/processes  → vault/processes
/docs       → vault/docs
/proc       → sanitized runtime state projection
/bin        → typed application tool/action manifests
/run        → audit/action trace projection
```

Static files live under `vault/`. Mutable employee/company state remains in application storage and is projected into `/proc` and `/run` at runtime. Raw personal data must not be committed to the vault.

## Relation to ecom VFS examples

The ecom examples have a real agent-facing filesystem with:

- `/AGENTS.MD` for root instructions;
- `/docs` for active decision policies and operational background;
- `/proc` for current state records;
- `/bin` for mechanical tools;
- `/run` for action traces.

Time-agent follows the same separation of responsibilities, but with a simpler implementation:

| ecom VFS concept | Time-agent vault equivalent |
|---|---|
| `/AGENTS.MD` | `vault/AGENTS.md` |
| `/docs` active policies | `vault/docs` runtime-facing product/methodology/boundary docs |
| `/proc` live state files | application state projected as `/proc`, schemas in `vault/proc/schemas` |
| `/bin` executables | typed TS use cases/Mastra tools, described by `vault/bin/*.md` manifests |
| `/run/actions` | domain events/audit projections, contract in `vault/run/README.md` |

## Static vs mutable data

Do not interpret “one vault” as “everything is a git file”. The vault is one logical workspace, but it has multiple physical sources:

| Logical path | Physical source |
|---|---|
| `/AGENTS.md` | git file `vault/AGENTS.md` |
| `/processes/*` | git files in `vault/processes` |
| `/docs/*` | git files in `vault/docs` |
| `/bin/*` | git manifests + typed TS application boundaries |
| `/proc/*` | typed, bounded `RuntimeProjectionBuilder` over profile/conversation/insight/feedback stores |
| `/run/*` | redacted `AuditEventStore` projections; never a transcript copy |

## Change lifecycle

1. Change or add a process file under `vault/processes/`.
2. Update `vault/processes/registry.json` and `vault/processes/index.md`.
3. Update `vault/AGENTS.md`, `vault/docs`, or `vault/bin` if the runtime contract changes.
4. Update or add executable specs.
5. Run `npm run verify`.
6. Review changes as code.

## Non-goals for the prototype

- No arbitrary shell access through `/bin`.
- No raw employee data committed under `vault/proc`.
- No full legal privacy contour inside `workday_guardrails` or `insight_extraction`.
- No benchmark-style VFS mount required; the namespace is implemented by loader/context projection and typed application boundaries.
