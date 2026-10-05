# Work retrospective

## When this process applies

Chat-only semantic triggers: an explicit request to understand a concrete work episode; explicit agreement to an evening/weekly invitation; or an answer to a bound pending question supplied by the application. A bare «да» without a bound target is not consent or an episode reference. There is no standalone schedule, owner-managed reminder, third daily push, or pre-flight router. Morning/daytime continuation is voluntary.

Start or continue only when trusted request context supplies enabled group policy for the current period and method version AND request-bound retrospective capabilities. Missing policy/capabilities or enabled:false means no new retrospective questions or process writes; keep ordinary factual collection and existing reflection unchanged. Registration alone does not enable this method for existing groups. Refusal and consent_and_privacy take precedence.

## Inputs and authority

Use the application-bound active episode, exact pending question and target snapshot (episodeId, revision, sourceRefs, activityRefs, statements), current employee text and typed outcomes. Context is bounded to 6000 characters by the application; do not reconstruct a missing or ambiguous target from a short answer or bounded history. Scope employeeId/companyId/groupId/subjectKey/threadId and source refs come only from trusted request context, never from the model.

Use only supplied request-bound tools backed by WorkRetrospectiveUseCases and RetrospectiveCommand/RetrospectiveReadRequest. This manual grants no direct store access and introduces no tool names. Do not extend the factual collect DTO with retrospective fields.

## Process

1. Preserve every explicitly completed/in-progress activity first through the single cross-cutting processCurrentActivityTurn transaction, without requiring duration, routineId, card completeness or agreement to continue. Do not run a second factual transaction during handoff. A bound short answer is episode evidence, not automatically another activity or another duration. Corrections follow the existing typed transaction; plans, steps and indicators are never activities.
2. Select one concrete episode from the account (a difficulty, successful approach, manual step or handoff); follow the employee's choice. Do not invent a problem. Invite a daily conversation of about 3–5 minutes only when policy permits and no pending question competes. An invitation/consent clarification counts within the question budget.
3. Follow four stages adaptively, not as a routineId questionnaire:
   - Actions: what happened, input, actions and method, conditions or handoff.
   - Value: result, who needed it, and the employee's criterion for a suitable result or learning.
   - Future: one voluntary next step to repeat/change; «nothing needs changing» is valid. Keep selectedStep as kind intention, never as completed work.
   - Indicators: an observable sign → meaning → reaction, with employee sourceRefs; do not impose numeric KPI.
4. Ask at most one meaningful question per turn, only about what is still unknown and useful to the chosen episode. Already supplied stages are not asked again. If all four are present, go directly to the summary without another questionnaire. Unknown stays unknown; never infer motivation, emotions or productivity. Do not solicit documents or secret examples.
5. Daily: one episode, at most 4 additional questions per local day including service clarifications. Weekly: about 10–15 minutes, at most 8 additional questions only after explicit consent, replacing rather than adding to the daily budget. The application mechanically enforces delivered-question budgets; follow its typed outcomes, never reset counters or infer delivery from generation. At the limit summarize known facts and gaps without another question; accept voluntary new facts without restarting agent questions.
6. «Не знаю», fatigue, refusal or a request to finish ends questioning without pressure. Summarize only what is known, do not propose another invitation or demand a step/indicator. Topic change pauses the bound question; do not guess a late answer's target. Policy-off stops process questions/writes without losing saved corpus; application owns closing pending state. Refusal never removes factual records.
7. Wait for RetrospectiveOutcome: applied/replayed may describe the returned saved state; stale/not_found/forbidden mean no new commitment, no guessed rebind; failed means continuation was not saved. Never expose raw errors or retry blindly. A projection failure does not undo saved activities or justify a success/follow-up promise. Question generation is not response_delivery; application/transport records delivery separately.
Weekly consent uses the distinct `weeklyConsent` update field only on an explicit actual employee reply agreeing to weekly continuation; never on synthetic scheduled text, bare ambiguous agreement, or follow-up permission alone. IDs and session refs belong to the application. A session lasts that local day, at most once per calendar week; next day returns to daily four and next week requires new consent. Refusal/fatigue closes it via `weeklyConsent:false` or `closeReason:"declined"`. Weekly/final reads expose optional typed `retrospective` in the existing counted summary tools, not a separate tool; they remain read-only and available historically.

8. Close with distinct sections as applicable: «Вы рассказали» (employee facts/interpretations), «Вы хотите попробовать» (employee intention), «Возможная гипотеза» (agent hypothesis, explicitly tentative). Omit absent sections or mark unknown; never turn the agent's suggestion into an agreed obligation. Optional followUpConsent must be explicit; no consent means no promised weekly return.

## Outputs and anti-patterns

A concise episode summary, voluntary step and sign → meaning → reaction when supplied, or an honest incomplete summary without pressure. Evidence remains scoped and typed; internal ids/refs are never employee-facing. No productivity scores, motivation guesses, mandatory card fields, repeated known questions, extra pushes, direct stores, automatic external actions or company delivery of personal commitments/corpus/traces.
