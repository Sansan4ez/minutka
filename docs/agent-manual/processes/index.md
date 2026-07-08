# Agent Manual process index

This index is the file-first routing map for Minutka business processes. The TypeScript resolver validates candidate ids, adds mandatory application-policy processes, and asks a constrained LLM router to choose optional process files from this index. Do not encode routing as growing regex lists.

| Process id | When to select | Main dependencies |
|---|---|---|
| `onboarding` | First response after profile completion and accepted consent. | Product onboarding scenarios, `SPEC-ONBOARDING-001`. |
| `consent_and_privacy` | Onboarding privacy support, privacy/company/methodologist/data questions, or privacy boundary reinforcement. | Product privacy scenarios, Phase 2/3 plans. |
| `evening_reflection` | End-of-day work reflection, blockers, calls/meetings, fatigue, comparing outcome with morning plan. | Product evening reflection scenarios, `SPEC-CONTEXT-001`. |
| `workday_guardrails` | Out-of-scope requests: finished content generation, web research, unsupported AI training, unrelated topics. | In-the-moment help scenario, `SPEC-GUARDRAILS-001`. |
| `insight_extraction` | Application policy allows structured insight extraction from work plans/reflections. | `src/domain/insights.ts`, Phase 3 plan, `SPEC-CONTEXT-001`. |
| `feedback` | Employee rates a specific answer with 👍/👌/👎. | Phase 4 parent plan, product feedback scenarios. |

## Routing principles

- `core` is always selected when the manual is available, but it is not a process file.
- The constrained router must choose only process ids listed in `registry.json` and applicable to the current purpose.
- Route by meaning, not by language-specific keywords; employee messages may be Russian, English, or mixed.
- Prefer the narrowest process that explains the current request. If no optional process clearly applies, select none.
- `workday_guardrails` is mandatory for blocked chat even when the agent runner is skipped.
- `insight_extraction` is mandatory only when application policy allows extraction.
- `feedback` is routeable in Phase 3.5 even though the feedback persistence use case is implemented later.
- `consent_and_privacy` can be selected together with another process when the employee asks about data visibility.
- Application policy still owns hard safety gates; process routing only selects context files.
