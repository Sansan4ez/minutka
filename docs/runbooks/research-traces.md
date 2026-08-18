# Research execution traces

## Storage

Every pilot `AssistantService` agent run is sampled at 100% and written to self-hosted PostgreSQL table `minutka_research.traces`. The versioned JSONB payload contains tenant/group/subject/request/message correlation, prompt/process/taxonomy/model versions, the employee input, the exact bounded context for each attempt, model steps, tool calls and results, output or error, latency, and token usage.

Conversation messages remain canonical in `minutka_private.messages`. Trace persistence is deliberately best-effort after the conversation write: a trace outage must not roll back an employee-visible conversation turn.

The persistence boundary applies the trace secret filter before SQL. Credential-shaped keys (authorization headers, API/access/refresh tokens, passwords, invite codes, database URLs and infrastructure secrets) are replaced with `[REDACTED]`. Ordinary conversation text, including names and work details, is retained as research corpus data; the post-pilot PII sanitizer is a separate roadmap item.

## Inspect one tenant/group

Use operator database credentials and always bind both tenant keys:

```sql
SELECT trace_id, request_id, message_id, subject_key, status,
       prompt_version, taxonomy_version, model, started_at, completed_at
FROM minutka_research.traces
WHERE company_id = 'company_id'
  AND group_id = 'group_id'
ORDER BY started_at, trace_id;
```

Inspect a JSON payload only after the same scope check:

```sql
SELECT jsonb_pretty(payload)
FROM minutka_research.traces
WHERE company_id = 'company_id'
  AND group_id = 'group_id'
  AND trace_id = 'trace_id';
```

Application readers use `ResearchTraceStore.list({ companyId, groupId })`; there is no unscoped list operation.

## JSON export for offline evaluation

`exportResearchTracesJson(scope, traces, exportedAt)` produces a versioned JSON document with the exact company/group scope, export timestamp, trace count and sanitized trace array. The next corpus/evaluation issue may wrap this helper in operator CLI/JSONL commands; do not replace the typed scoped reader with ad-hoc unbounded SQL in product code.

## Degradation and missing traces

If trace persistence fails:

1. the conversation turn remains durable and the response is still returned;
2. `AssistantService` emits a `research_trace_missing` operational warning with request/message/status and a redacted error class;
3. a `trace_missing` audit event is attempted with only `reason` and `status` metadata;
4. operators investigate PostgreSQL availability, pending migrations and runtime grants, then correlate the missing request/message with `minutka_private.messages` and `minutka_audit.events`.

If both trace and audit storage are unavailable, the operational warning remains the visible drop signal. Never log trace payloads or provider errors containing request data while diagnosing the outage.
