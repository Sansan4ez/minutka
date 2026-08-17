import type { AuditEventStore } from "./audit-event-store.js";
import type { ConversationStore, ConversationTurn } from "./conversation-store.js";
import { countUnicodeCharacters } from "./context-budget.js";
import { renderedThreadSummaryCharacters } from "./runtime-projections/runtime-projection-renderer.js";
import {
  threadSummaryReductionMarker,
  threadSummarySectionHeadings,
  type ThreadSummarizer,
} from "./thread-summarizer.js";
import type { ThreadSummary, ThreadSummaryStore } from "./thread-summary-store.js";
import type { Clock, IdGenerator } from "./runtime-primitives.js";
import type { UsageRecorder } from "./usage-recorder.js";

export type ThreadCompactionService = {
  compact(input: { employeeId: string; threadId: string; requestId: string }): Promise<void>;
  drain(): Promise<void>;
};

export function createThreadCompactionService(deps: {
  conversationStore: ConversationStore;
  summaryStore: ThreadSummaryStore;
  summarizer: ThreadSummarizer;
  recentTurnLimit: number;
  batchTurnLimit: number;
  fieldCharacterLimit: number;
  summaryCeiling: number;
  clock: Clock;
  idGenerator: IdGenerator;
  auditEventStore?: AuditEventStore;
  usageRecorder?: UsageRecorder;
}): ThreadCompactionService {
  const queues = new Map<string, Promise<void>>();
  const runCompaction = async (input: { employeeId: string; threadId: string; requestId: string }): Promise<void> => {
    let previous: ThreadSummary | undefined;
    let pending: ConversationTurn[];
    try {
      previous = await deps.summaryStore.get(input);
      pending = await deps.conversationStore.getTurnsBeforeRecent({
        employeeId: input.employeeId,
        threadId: input.threadId,
        recentLimit: deps.recentTurnLimit,
        limit: deps.batchTurnLimit,
        afterMessageId: previous?.watermark.throughMessageId,
      });
    } catch (error) {
      await auditSafely(deps, input, undefined, "thread_summary_failed", {
        reason: errorReason(error),
        turnCount: 0,
        previousCharacters: 0,
      });
      return;
    }
    if (pending.length === 0) return;

    let generated: { text: string };
    try {
      const summarized = await deps.summarizer({
        previous,
        turns: pending,
        ceiling: deps.summaryCeiling,
        fieldCharacters: deps.fieldCharacterLimit,
      });
      // Compaction runs once per active turn, so its tokens are a load-proportional
      // part of the owner's spend and must be attributed before the summary is
      // parsed — a malformed summary still cost money.
      if (summarized.usage) {
        await deps.usageRecorder?.record({
          userId: input.employeeId,
          requestId: input.requestId,
          source: "summarization",
          threadId: input.threadId,
          usage: summarized.usage,
        });
      }
      generated = summarized;
      const sections = parseStructuredSummary(generated.text);
      const watermark = {
        fromMessageId: previous?.watermark.fromMessageId ?? pending[0]!.messageId,
        throughMessageId: pending.at(-1)!.messageId,
      };
      const updatedAt = deps.clock.now();
      generated = {
        text: buildBoundedSummary(sections, deps.summaryCeiling, (text) => renderedThreadSummaryCharacters({
          employeeId: input.employeeId,
          threadId: input.threadId,
          text,
          watermark,
          updatedAt,
        })),
      };
    } catch (error) {
      await auditSafely(deps, input, pending.at(-1)?.messageId, "thread_summary_failed", {
        reason: errorReason(error),
        turnCount: pending.length,
        previousCharacters: previous ? countUnicodeCharacters(previous.text) : 0,
      });
      return;
    }

    const summary: ThreadSummary = {
      employeeId: input.employeeId,
      threadId: input.threadId,
      text: generated.text,
      watermark: {
        fromMessageId: previous?.watermark.fromMessageId ?? pending[0]!.messageId,
        throughMessageId: pending.at(-1)!.messageId,
      },
      updatedAt: deps.clock.now(),
    };
    try {
      const result = await deps.summaryStore.save(summary, previous?.watermark.throughMessageId);
      if (result === "conflict") {
        await auditSafely(deps, input, summary.watermark.throughMessageId, "thread_summary_failed", {
          reason: "thread_summary_conflict",
          turnCount: pending.length,
          previousCharacters: previous ? countUnicodeCharacters(previous.text) : 0,
        });
        return;
      }
    } catch (error) {
      await auditSafely(deps, input, summary.watermark.throughMessageId, "thread_summary_failed", {
        reason: errorReason(error),
        turnCount: pending.length,
        previousCharacters: previous ? countUnicodeCharacters(previous.text) : 0,
      });
      return;
    }
    await auditSafely(deps, input, summary.watermark.throughMessageId, "thread_summary_updated", {
      turnCount: pending.length,
      summaryCharacters: countUnicodeCharacters(summary.text),
    });
  };
  return {
    compact(input) {
      const key = `${input.employeeId}\u0000${input.threadId}`;
      const previous = queues.get(key) ?? Promise.resolve();
      const current = previous.catch(() => undefined).then(() => runCompaction(input));
      queues.set(key, current);
      void current.finally(() => {
        if (queues.get(key) === current) queues.delete(key);
      });
      return current;
    },
    async drain() {
      while (queues.size > 0) {
        await Promise.allSettled([...queues.values()]);
      }
    },
  };
}

type ThreadSummarySections = Record<typeof threadSummarySectionHeadings[number], string>;

function parseStructuredSummary(text: string): ThreadSummarySections {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const firstNonEmptyLine = lines.findIndex((line) => line.trim().length > 0);
  if (firstNonEmptyLine < 0 || lines[firstNonEmptyLine] !== `## ${threadSummarySectionHeadings[0]}`) {
    throw new Error("summary_sections_missing");
  }

  const sectionLines = threadSummarySectionHeadings.map(() => [] as string[]);
  let sectionIndex = -1;
  for (const line of lines.slice(firstNonEmptyLine)) {
    const expectedHeading = threadSummarySectionHeadings[sectionIndex + 1];
    if (expectedHeading !== undefined && line === `## ${expectedHeading}`) {
      sectionIndex += 1;
      continue;
    }
    if (/^##(?:[ \t]|$)/u.test(line.trimStart())) throw new Error("summary_sections_missing");
    sectionLines[sectionIndex]!.push(line);
  }
  if (sectionIndex !== threadSummarySectionHeadings.length - 1) throw new Error("summary_sections_missing");

  return Object.fromEntries(threadSummarySectionHeadings.map((heading, index) => [
    heading,
    trimBlankBoundaryLines(sectionLines[index]!).join("\n"),
  ])) as ThreadSummarySections;
}

function trimBlankBoundaryLines(lines: readonly string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]!.trim().length === 0) start += 1;
  while (end > start && lines[end - 1]!.trim().length === 0) end -= 1;
  return lines.slice(start, end);
}

function buildCanonicalSummary(sections: ThreadSummarySections): string {
  return threadSummarySectionHeadings.map((heading) => {
    const marker = `## ${heading}`;
    return sections[heading].length === 0 ? marker : `${marker}\n${sections[heading]}`;
  }).join("\n");
}

function buildBoundedSummary(
  sections: ThreadSummarySections,
  ceiling: number,
  renderedCharacters: (text: string) => number,
): string {
  const canonical = buildCanonicalSummary(sections);
  if (renderedCharacters(canonical) <= ceiling) return canonical;

  const prefixes = threadSummarySectionHeadings.map((heading, index) => [
    `## ${heading}`,
    ...(index === 0 ? [threadSummaryReductionMarker] : []),
  ].join("\n"));
  const minimum = prefixes.join("\n");
  if (renderedCharacters(minimum) > ceiling) throw new Error("summary_ceiling_too_small");

  const bodies = threadSummarySectionHeadings.map((heading) => Array.from(sections[heading]));
  const totalBodyCharacters = bodies.reduce((sum, body) => sum + body.length, 0);
  let low = 0;
  let high = totalBodyCharacters;
  let best = minimum;
  while (low <= high) {
    const retainedCharacters = Math.floor((low + high) / 2);
    const candidate = buildReducedSummary(prefixes, bodies, retainedCharacters);
    if (renderedCharacters(candidate) <= ceiling) {
      best = candidate;
      low = retainedCharacters + 1;
    } else {
      high = retainedCharacters - 1;
    }
  }
  return best;
}

function buildReducedSummary(prefixes: readonly string[], bodies: readonly string[][], retainedCharacters: number): string {
  const allocations = allocateBodyCharacters(bodies.map((body) => body.length), retainedCharacters);
  return prefixes.map((prefix, index) => {
    const body = bodies[index]!.slice(0, allocations[index]).join("");
    return body.length === 0 ? prefix : `${prefix}\n${body}`;
  }).join("\n");
}

function allocateBodyCharacters(lengths: readonly number[], budget: number): number[] {
  const allocations = lengths.map(() => 0);
  let remaining = budget;
  for (const [index, length] of lengths.entries()) {
    if (length === 0 || remaining === 0) continue;
    allocations[index] = 1;
    remaining -= 1;
  }
  while (remaining > 0) {
    const active = lengths.map((length, index) => ({ length, index })).filter(({ length, index }) => allocations[index]! > 0 && allocations[index]! < length);
    if (active.length === 0) break;
    const share = Math.max(1, Math.floor(remaining / active.length));
    for (const { length, index } of active) {
      const added = Math.min(share, length - allocations[index]!, remaining);
      allocations[index] = allocations[index]! + added;
      remaining -= added;
      if (remaining === 0) break;
    }
  }
  return allocations;
}

async function auditSafely(
  deps: Parameters<typeof createThreadCompactionService>[0],
  input: { employeeId: string; threadId: string; requestId: string },
  messageId: string | undefined,
  type: "thread_summary_updated" | "thread_summary_failed",
  metadata: Record<string, string | number | boolean>,
): Promise<void> {
  if (!deps.auditEventStore) return;
  try {
    await deps.auditEventStore.append({
      id: deps.idGenerator.auditEventId(),
      requestId: input.requestId,
      type,
      employeeId: input.employeeId,
      threadId: input.threadId,
      ...(messageId ? { messageId } : {}),
      occurredAt: deps.clock.now(),
      metadata,
    });
  } catch (error) {
    console.warn(`Assistant thread compaction audit failed (${error instanceof Error ? error.name : "UnknownError"}).`);
  }
}

function errorReason(error: unknown): string {
  if (error instanceof Error && error.message === "summary_ceiling_too_small") return error.message;
  if (error instanceof Error && error.message === "summary_sections_missing") return error.message;
  return error instanceof Error ? error.name : "UnknownError";
}
