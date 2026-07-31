import { assertUserId } from "./document-store.js";
import type { Clock } from "./runtime-primitives.js";
import { systemClock } from "./runtime-primitives.js";
import { randomUUID } from "node:crypto";

/** Owner-scoped persistence boundary for the currently active conversation thread. */
export type ConversationThreadStore = {
  rotateThread(input: { userId: string; nextThreadId: string; updatedAt: string }): Promise<void>;
};

/** Typed use-case for starting a fresh dialogue without touching durable owner data. */
export class ConversationThreadService {
  private readonly clock: Clock;
  private readonly ids: { threadId(): string };

  constructor(
    private readonly store: ConversationThreadStore,
    deps: { clock?: Clock; idGenerator?: { threadId(): string } } = {},
  ) {
    this.clock = deps.clock ?? systemClock;
    this.ids = deps.idGenerator ?? { threadId: () => `thread_${randomUUID()}` };
  }

  async reset(input: { userId: string }): Promise<{ threadId: string }> {
    const userId = assertUserId(input.userId);
    const threadId = this.ids.threadId();
    await this.store.rotateThread({ userId, nextThreadId: threadId, updatedAt: this.clock.now() });
    return { threadId };
  }
}
