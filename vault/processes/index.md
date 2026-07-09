# Agent Vault process index

This index is the file-first routing map for Minutka business processes. It follows the `ecom1-process-architect` pattern: each row explains **when** to select a process, **why** it applies, and whether the process owns a state-changing side effect.

`Why it applies` is explicit because routing should not depend on hidden keyword rules: the SO-CoT constrained decision router uses this column as the short rationale map before reading full process files.

`Mutating` means the process may authorize or trigger a persistent side effect beyond composing the answer. In Time-agent, message/event logging is owned by `MinutkaService.chat()` and is not counted here; process-owned mutation means profile update, insight persistence, feedback persistence, or a future `/bin` operation.

| Process id | When to select | Why it applies | Mutating |
|---|---|---|---|
| `onboarding` | First response after profile completion and accepted consent. | Establishes the initial working relationship, persona, and response style after the profile is saved. | Profile already saved by application flow; no extra mutation. |
| `consent_and_privacy` | Onboarding privacy support, privacy/company/methodologist/data questions, or privacy boundary explanation. | Answers data-visibility questions without mixing privacy policy into work-scope or insight processes. | No. Future external privacy contour may own data export/deletion. |
| `evening_reflection` | End-of-day work reflection, blockers, calls/meetings, fatigue, comparing outcome with morning plan. | Helps interpret a workday reflection with thread context and prepare useful response context. | No. |
| `workday_guardrails` | Request asks Minutka to do work outside its role: finished content generation, web research, unsupported AI training, unrelated topic, or request-integrity override. | Business-scope boundary process: decide a soft refusal and return to working-day help without invoking the main answer chain. | Audit event only. |
| `insight_extraction` | Conversation decision marks the allowed turn as an insight candidate after a substantive workday plan/reflection/blocker/load signal. | Business-signal extraction is a process, not keyword code: it decides which structured signal kinds are appropriate. | Yes: persists structured insights. |
| `feedback` | Employee rates a specific answer with 👍/👌/👎 or similar quick reaction. | Feedback is its own process because it concerns the previous answer quality, not the current workday content. | Future feedback record. |

## Routing principles

- `core` is always selected when the manual is available, but it is not a process file.
- The SO-CoT constrained decision router must choose only process ids listed in `registry.json` and applicable to the current purpose.
- Route by meaning, not by language-specific keywords; employee messages may be Russian, English, or mixed.
- Prefer the narrowest process set that explains the current turn. If no optional process clearly applies, select only `core`.
- `workday_guardrails` and `insight_extraction` are ordinary business processes selected by the decision router, not hard-coded deterministic WorkPolicy branches.
- `consent_and_privacy` stays separate from `workday_guardrails` and `insight_extraction`: full personal-data/privacy policy is a later external contour, while this process only explains current product boundaries.
- The application layer validates the selected ids, enforces side effects mechanically, and never grows a hidden regex/keyword routing table.
