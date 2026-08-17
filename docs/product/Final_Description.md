# Final Description — agent "Minutka"

> **Продуктовый baseline «Минутки».** Реализованные privacy-границы и пилотные не-цели уточняет [RFC мультитенантного контура](../architecture/rfc-minutka-tenancy-and-reporting.md).

## 1. Product Summary

`agent "Minutka"` is an AI partner for employees who participate in a corporate AI education program. During a two-week program cycle, an employee communicates with Minutka mainly through Telegram: plans the day, checks in during the day if needed, reflects in the evening, and receives short personalized feedback about work patterns, energy, focus, and possible simplifications.

The same product has a second, company-facing value: it turns anonymized patterns from employee conversations into an automation map for the client company. This map helps leadership understand where time is spent, which repetitive tasks are candidates for automation, and which areas may need attention because of workload or stress signals.

The product is not a general-purpose chatbot and not a tool that performs work instead of the employee. Its main role is to listen, structure, reflect, notice patterns, and suggest directions for improvement while preserving employee privacy.

## 2. Confirmed Product Context

The product is designed for a B2B corporate learning context. A client company buys or joins an AI training program run by the "Algorithm" team. Employees use Minutka for approximately two weeks as part of that program.

Main audiences:

- **Employee of the client company** — the direct daily user. The employee uses Telegram, mostly voice messages, and receives support, planning help, reflections, and personal summaries.
- **Company owner / director / leadership** — the buyer or main business stakeholder. They receive only anonymized, aggregated insights and an automation map, not individual employee conversations.
- **Program methodologist / operator** — the internal operator from the Algorithm team. The methodologist creates program flows, tracks participation, sends soft reminders, and prepares or finalizes reports for the client.

## 3. Product Archetype and Shell

### Archetype

The product is best understood as a **Telegram bot with an AI-agent backend and a separate web panel for the methodologist**.

### Shells

The product has two user-facing shells:

1. **Telegram bot shell for employees**  
   This is the main entry point for daily employee interaction. The employee starts the bot, receives prompts, sends voice or text messages, sees personal summaries, and manages basic preferences.

2. **Web panel shell for methodologists**  
   This is a browser-based operator interface used by the Algorithm team to create flows, monitor engagement, generate reports, and prepare the client-facing automation map.

The shells are not the whole product. They are entry surfaces connected to a separate backend and data-processing runtime.

## 4. Core Product Promise

For the employee, Minutka should feel like a careful personal work diary with an AI partner: it remembers context, asks useful questions, helps notice patterns, and supports better planning without pressure or evaluation.

For the client company, Minutka should produce a credible anonymized picture of how work happens across the team and where automation can create value.

For the methodologist, Minutka should reduce manual work in running a two-week program, tracking participation, and preparing the final report.

## 5. Key User Scenarios

### Scenario 1 — Employee joins the program

- **Actor / goal:** Employee wants to start using Minutka as part of the company program.
- **Action:** Employee opens an individual Telegram invitation link, confirms participation, accepts the privacy explanation, answers onboarding questions, and chooses a communication style/persona.
- **Expected result:** Minutka creates an initial personal context: role, typical tasks, AI familiarity level, preferred tone, and basic working goals.
- **Success criterion:** The employee understands what Minutka does, what the company will and will not see, and can begin daily check-ins without help from the methodologist.

### Scenario 2 — Methodologist creates a program flow

- **Actor / goal:** Methodologist wants to launch a two-week program for a client company.
- **Action:** Methodologist opens the web panel, creates a flow with client name and dates, uploads or enters a list of employees with names and roles, and generates individual Telegram invitation links.
- **Expected result:** The system prepares the employee cohort and makes onboarding links available.
- **Success criterion:** Each employee can be invited into the correct flow, and the methodologist can see flow status in the web panel.

### Scenario 3 — Employee completes morning planning

- **Actor / goal:** Employee wants to plan the workday with help from Minutka.
- **Action:** Employee receives or opens the morning check-in, shares the main tasks and priorities, and optionally discusses how to approach the day.
- **Expected result:** Minutka reflects the plan, highlights likely priorities, and may suggest a practical way to structure the day based on known context.
- **Success criterion:** The employee leaves with a clearer plan for the day, and the system stores relevant planning context for later reflection.

### Scenario 4 — Employee performs an optional midday check-in

- **Actor / goal:** Employee wants to adjust the day when priorities, mood, or workload change.
- **Action:** Employee sends a text or voice update during the day or responds to an optional check-in prompt.
- **Expected result:** Minutka compares the update with the morning plan, notices changes, and helps the employee reframe or reprioritize without pressure.
- **Success criterion:** The employee receives a useful adjustment and the system updates the daily context.

### Scenario 5 — Employee completes evening reflection

- **Actor / goal:** Employee wants to make sense of the day and prepare for tomorrow.
- **Action:** Employee sends a 1–3 minute voice message or text reflection about what happened, what helped, what blocked progress, and how they feel.
- **Expected result:** Minutka transcribes or reads the message, extracts work themes and emotional signals, reflects the day back to the employee, notices patterns if enough context exists, and suggests a small next step for tomorrow.
- **Success criterion:** The employee feels heard, receives a concise useful response, and the system captures structured data without exposing private details to the company.

### Scenario 6 — Employee asks for in-the-moment help

- **Actor / goal:** Employee is stuck on a task and wants help with approach, not someone to do the task for them.
- **Action:** Employee sends a message such as "I am stuck with a report and do not know how to structure it."
- **Expected result:** Minutka answers only if the request is about the employee's use of working time or the emotional state connected with work. It may ask clarifying questions or suggest a structure, method, or simplification. If the employee asks about another topic, Minutka gently refuses and returns the conversation to the intended theme.
- **Success criterion:** The employee receives direction that helps them continue independently, and Minutka stays within its support-and-structure role.

### Scenario 7 — Employee reviews personal context

- **Actor / goal:** Employee wants to know what Minutka remembers about them and correct it if needed.
- **Action:** Employee opens the personal "Me" area in Telegram and reviews the stored portrait, preferences, work patterns, or summaries.
- **Expected result:** Minutka shows user-readable personal context and allows correction or deletion where required.
- **Success criterion:** The employee can understand and influence their own stored profile, reinforcing trust and privacy.

### Scenario 8 — Employee receives a weekly summary

- **Actor / goal:** Employee wants to see patterns from the first week.
- **Action:** At the weekly checkpoint, Minutka prepares a personal summary covering energy, focus, repeated tasks, blockers, and possible improvements.
- **Expected result:** The employee sees a meaningful summary and can confirm or reject observed patterns.
- **Success criterion:** The summary feels recognizable to the employee and improves the stored context only when the employee's response supports it.

### Scenario 9 — Employee receives final personal report

- **Actor / goal:** Employee wants a personal result after the two-week cycle.
- **Action:** At the end of the program, employee receives a personal report and a personal improvement or automation plan.
- **Expected result:** The report summarizes work patterns, repeated tasks, energy patterns, areas of friction, and practical ideas for simplifying work.
- **Success criterion:** The employee receives individual value while their personal details remain private from the company and methodologist.

### Scenario 10 — Methodologist monitors engagement

- **Actor / goal:** Methodologist wants to understand whether the program is progressing normally.
- **Action:** Methodologist opens a flow dashboard and reviews participation status, last activity, completion percentage, and aggregate indicators.
- **Expected result:** The methodologist can see who is active, lagging, or dropped off, while not seeing private conversation content or individual emotional states. If an employee misses two days in a row, the status is "lagging"; if an employee misses three days or more, the status is "dropped off".
- **Success criterion:** The methodologist can manage participation without crossing employee privacy boundaries.

### Scenario 11 — Methodologist sends a soft reminder

- **Actor / goal:** Methodologist wants to re-engage employees who stopped responding.
- **Action:** Methodologist uses the web panel to send a gentle reminder through the Telegram bot to a selected group of lagging participants.
- **Expected result:** Employees receive a non-pressuring message that invites them to return.
- **Success criterion:** Reminder delivery is possible without exposing private employee content to the methodologist.

### Scenario 12 — Methodologist prepares the final automation map

- **Actor / goal:** Methodologist wants to create a client-ready report at the end of the program.
- **Action:** Methodologist opens the final report area, reviews generated aggregates, edits or supplements the narrative, and exports the final automation map.
- **Expected result:** The system provides anonymized patterns: time distribution, repeated tasks, automation candidates, emotional background, priority recommendations, and possible 30/60/90-day actions.
- **Success criterion:** The client receives a useful automation map, and no individual employee transcript, task list, or emotional state is revealed.

### Scenario 13 — Company leadership receives anonymized insights

- **Actor / goal:** Company leadership wants to understand automation opportunities and team-level work patterns.
- **Action:** Leadership reviews the final automation map prepared by the methodologist.
- **Expected result:** Leadership sees aggregated insights and recommendations, not raw conversations or individual employee content. The only person-specific information the company may receive is the participation fact manually escalated by the methodologist under the program procedure.
- **Success criterion:** The report supports business decisions while preserving trust in the program.

### Scenario 14 — Employee deletes personal data

- **Actor / goal:** Employee wants control over personal information.
- **Action:** Employee requests deletion in the Telegram dialogue. Minutka explains the exact scope and passes the request to the trusted operator; the agent does not receive a deletion tool.
- **Expected result:** After an explicit irreversible-action confirmation, the operator deletes the employee's profile, conversation history, personal activities and insights, schedules, personal documents and artifacts, Telegram binding, and onboarding drafts. Already anonymized company rows remain unlinkable and unchanged.
- **Success criterion:** The employee can initiate deletion without intervention from the client company, receives a clear completion result from the operator, cannot reuse the old invite, and can return only through a new invite.

## 6. Top-Level Product Parts

### 6.1 Telegram Bot Shell

The Telegram bot is the employee-facing shell. It handles onboarding, daily prompts, voice/text input, personal summaries, settings, persona selection, and employee-facing privacy explanations.

It should not contain the full product logic by itself. It should pass employee interactions into the backend and return generated responses to the employee.

### 6.2 AI Agent Backend Runtime

This is the core runtime that interprets messages, manages dialogue state, uses AI models and speech recognition, updates employee context, generates responses, and produces structured signals for aggregation.

Mastra is the chosen implementation framework for the AI runtime: agents, workflows, tools, memory, guardrails/processors, storage adapters, voice/provider access, and deployable runtime integration should be designed around it.

### 6.3 Methodologist Web Panel

The web panel is a separate shell for internal operators from the Algorithm team. It supports program flow setup, cohort management, engagement monitoring, reminder actions, and report preparation.

The methodologist panel has a strict privacy boundary: it must not provide access to individual transcripts, individual task lists, or individual emotional states.

### 6.4 Data Storage and Privacy Layer

The product needs persistent storage for several different kinds of data:

- employee identity and participation records;
- personal employee context and conversation history;
- anonymized or aggregated team-level signals;
- report data and generated summaries;
- feedback ratings on AI responses;
- audit logs for sensitive data access.

The source materials require personal data protection, separation between personal context and anonymized company aggregates, and employee ability to delete their data. Exact storage technology and encryption design remain future decisions.

### 6.5 Reporting and Automation Map Generation

The reporting part turns anonymized program data into outputs for the methodologist and client leadership. It includes weekly or interim summaries, final employee reports, and the client-facing automation map.

This part depends on the backend's extracted signals and privacy rules. It must not bypass the anonymization boundary.

### 6.6 External AI and Speech Providers

The product will likely use external or separately hosted services for speech recognition and language-model processing. The specific providers are not final. Requirements mentioned in the source materials include Russian language quality, speed, cost, context quality, and suitability for the desired tone.

These providers are external dependencies, not user-facing product shells.

## 7. Candidate Clusters and Standalone Modules for Future Steps

These are not implementation classes or file structures. They are candidate system blocks that the next stages can refine into clusters and modules.

### Telegram Employee Experience Cluster

Likely responsibilities:

- onboarding and consent flow;
- daily check-in prompts;
- voice/text message intake;
- employee settings and persona selection;
- personal context display;
- data deletion request surface.

### Dialogue and AI Response Cluster

Likely responsibilities:

- message understanding;
- speech-to-text coordination;
- AI prompt and persona behavior;
- response generation;
- feedback rating handling;
- tone and safety constraints.

### Employee Memory and Personal Context Cluster

Likely responsibilities:

- storing employee role, regular tasks, goals, preferences, AI familiarity, and working patterns;
- exposing personal context to the employee;
- updating context from confirmed or inferred patterns;
- respecting deletion and privacy rules.

### Aggregation and Anonymization Cluster

Likely responsibilities:

- extracting team-level patterns from employee interactions;
- separating personal data from aggregate signals;
- enforcing minimum group-size rules;
- preventing methodologist or company access to individual-level sensitive information.

### Program Flow Management Cluster

Likely responsibilities:

- creating client flows;
- managing employee lists and invitation links;
- tracking program day and participation status;
- supporting reminders and completion monitoring.

### Reporting Cluster

Likely responsibilities:

- weekly employee summaries;
- final personal reports;
- interim methodologist summaries;
- final client automation map;
- export preparation for client presentation.

### Privacy, Consent, and Audit Module

Likely responsibilities:

- privacy explanation and consent status;
- access restrictions;
- data deletion action;
- audit log of sensitive access;
- privacy rules for reports and dashboards.

### AI Provider Integration Modules

Likely responsibilities:

- speech recognition provider access;
- language model provider access;
- possible provider switching after technical evaluation;
- cost and quality monitoring signals.

These integration blocks may be peer modules following a shared provider contract rather than one artificial monolithic cluster.

## 8. Important Boundaries

### Employee personal boundary

Employee conversations, personal context, transcripts, emotional state, and task-level details belong to the employee-facing side of the product. They may be used by the AI to help that employee but must not be visible to the company or methodologist as individual records.

### Aggregated company insight boundary

Client leadership receives aggregated and anonymized insights under the minimum group-size rule: if a group/category has fewer than 5 people, analytical data is not shown. Separately, because the company organizes and pays for the program, the methodologist may manually communicate the participation fact for a named employee; this exception contains no conversation content, task quality, emotional state, or employee evaluation.

### Methodologist access boundary

The methodologist can operate program flows and reports but should not see raw personal conversations, individual tasks, or individual emotional states. The web panel must embody this as a product boundary, not only as a policy promise.

The methodologist may see individual engagement labels needed to operate the program:

- **lagging** — the employee has missed two days in a row;
- **dropped off** — the employee has missed three days or more.

These labels are based on participation activity only, not on conversation content, task quality, emotional state, or AI evaluation of the employee.

### Telegram shell to backend boundary

Telegram is the employee entry shell. The backend should own AI processing, memory, aggregation, and reporting logic. Exact transport or API shape is not defined yet.

### Backend to AI provider boundary

Speech recognition and language model services are outside or separately hosted from the product's own logic. Provider choice is open and should be evaluated for Russian quality, speed, cost, and privacy implications.

External AI and speech providers may be used only within the disclosed runtime boundary. The employee's chosen display name is included in LLM context without masking so the agent can address the employee naturally; the consent text explicitly warns that request text and required context go to the LLM provider. Phone numbers and transport identifiers are not included in assistant projections or LLM context. Voice audio is sent separately to the configured STT provider and is not retained by the application.

### In-the-moment help boundary

Minutka's in-the-moment help is limited by topic. It is allowed only for:

- discussing how the employee uses working time;
- reflecting on emotional state when it is connected with work and the working day.

If the employee asks about unrelated topics, Minutka should gently refuse to answer and return to the intended product theme.

### Personal data to anonymized aggregate boundary

The system must separate personally identifiable and raw conversation data from aggregate signals used in dashboards and reports. This is one of the most important architectural boundaries for the product.

## 9. Functional Scope for the First Version

The first version should focus on the two-week B2B program cycle.

Core capabilities:

- employee onboarding through Telegram;
- privacy explanation and participation confirmation;
- persona or communication style selection;
- voice and text daily dialogue;
- morning planning, optional midday check-in, evening reflection;
- in-the-moment help limited to working-time discussion and work-related emotional state;
- employee feedback on AI answers;
- personal employee context and summaries;
- weekly and final personal reports;
- methodologist creation of flows and invitation links;
- methodologist engagement dashboard;
- soft reminders to lagging participants;
- anonymized aggregation of team patterns;
- final automation map for the client company;
- data deletion path for employees.

## 10. Out of Scope for the First Version

The source materials explicitly or strongly exclude the following from the first version:

- CRM, calendar, task tracker, or other business-system integrations;
- writing final work products for employees, such as proposals, posts, emails, or reports;
- internet research on behalf of the employee;
- universal chat-assistant behavior;
- full AI-tool education inside Minutka;
- video calls, group chats, or team collaboration features;
- native mobile application outside Telegram;
- open B2C version for individuals without a company program;
- direct manager access to individual employee conversations or emotional state.

## 11. Tone and Behavior Principles

Minutka should be calm, careful, and on the employee's side. It should not pressure, shame, evaluate, or act as a corporate control tool.

Minutka does not have one fixed character. It has several personas with different tone and focus for different employee types. The employee chooses the persona that feels closer and can change this choice at any time.

Confirmed persona directions:

- **Support** — warmer, softer, more emotionally careful.
- **Efficiency** — more concise, structured, and practical.

The **Support** persona starts with care and then moves to work: it notices tiredness, supports the employee, and gently leads toward conclusions. It is intended for employees who need to feel support.

The **Efficiency** persona is dry and applied: less empathy, more focus on what can be done faster, where time can be saved, and what can be optimized. It is intended for employees who value usefulness and results.

All personas must still obey the same basic boundaries: no pressure, no moralizing, no individual performance evaluation, and no disclosure of private data to the company.

The current baseline treats emotional support as a persona/tone and focus layer inside the workday reflection product, not as a separate standalone wellness product equal to work planning.

## 12. Key Architectural Assumptions

These assumptions are used only to build the first architectural baseline and should be confirmed or corrected later.

- The first version is B2B and tied to a two-week corporate AI education program.
- Employee interaction happens only through Telegram at launch.
- The methodologist panel is a separate browser-based product part.
- The AI backend/runtime is separate from both user-facing shells.
- Personal employee context and anonymized company aggregates are stored and accessed through separate privacy rules.
- The company receives aggregated team-level outputs, not raw conversations.
- The methodologist can see participation status per employee, but not sensitive personal content.
- The methodologist may see individual activity-based labels: "lagging" after two missed days and "dropped off" after three or more missed days.
- If an employee deletes personal data, already anonymized aggregate data may remain, provided it cannot identify the employee.
- The final client report is first assembled in the methodologist web panel; later export to PDF may be supported.
- External AI providers receive the request text and bounded context disclosed by consent; the employee's chosen display name is sent to the LLM provider without masking.
- Phone numbers and transport identifiers are excluded from assistant projections; voice audio goes only to the configured STT provider and is not retained by the application.
- In-the-moment help is allowed only for working-time discussion and work-related emotional state; unrelated questions should receive a gentle refusal and redirection.
- Speech recognition and LLM providers are not final.
- Mastra is the implementation baseline for the AI runtime, while the product boundaries in this document remain framework-independent.

## 13. Open Questions That Matter for Architecture

There are no remaining critical open questions for the Description stage.

Future stages may still refine operational details such as exact provider choice and report export mechanics. The pilot decision on the chosen display name is closed: it is sent to the LLM provider without masking, while phone numbers and transport identifiers remain outside assistant context.

## 14. Foundation for the Next Steps

For `Virtual Simulation`, the strongest flows to test are:

- employee onboarding and consent;
- daily morning/midday/evening interaction;
- employee review and correction of personal context;
- privacy-safe methodologist monitoring;
- final automation map generation;
- employee data deletion.

For `Diagram Modules`, the initial architecture should preserve these top-level parts and boundaries:

- Telegram bot shell;
- methodologist web panel shell;
- AI agent backend runtime;
- employee memory and personal-context area;
- anonymized aggregation area;
- reporting and automation-map area;
- external speech and language-model providers;
- privacy/consent/audit boundary across all sensitive flows.
