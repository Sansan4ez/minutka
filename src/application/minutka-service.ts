import type { InMemoryWorld, ChatMessage } from "./in-memory-world.js";

export type ChatInput = {
  employeeId: string;
  threadId: string;
  text: string;
};

export type ChatResult = {
  messageId: string;
  response: string;
};

/**
 * Генератор ответов агента.
 * В executable specs Этапа 1 инжектируется mock-runner,
 * чтобы проверки не зависели от LLM/API.
 * В runtime используется Mastra Agent runner (src/mastra/agent-runner.ts).
 */
export type AgentRunner = (input: ChatInput) => Promise<string>;

export class MinutkaService {
  constructor(
    private readonly world: InMemoryWorld,
    private readonly agentRunner: AgentRunner,
  ) {}

  async chat(input: ChatInput): Promise<ChatResult> {
    this.world.counters.message++;
    const messageId = `msg_${this.world.counters.message}`;
    const timestamp = this.world.now();

    this.world.events.push({
      type: "ChatMessageReceived",
      employeeId: input.employeeId,
      threadId: input.threadId,
      text: input.text,
      timestamp,
    });

    const response = await this.agentRunner(input);

    this.world.events.push({
      type: "ChatResponseGenerated",
      employeeId: input.employeeId,
      threadId: input.threadId,
      response,
      timestamp: this.world.now(),
    });

    const message: ChatMessage = {
      id: messageId,
      employeeId: input.employeeId,
      threadId: input.threadId,
      text: input.text,
      response,
      timestamp,
    };
    this.world.messages.push(message);

    return { messageId, response };
  }
}
