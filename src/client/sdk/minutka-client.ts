import type { MinutkaApi } from "../../server/http/in-process-server.js";
import { z } from "zod";

const chatRequest = z.strictObject({
  employeeId: z.string().min(1),
  threadId: z.string().min(1),
  text: z.string().min(1),
});

const chatResponse = z.strictObject({
  messageId: z.string(),
  response: z.string(),
});

function validate<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new Error(
      `${label} validation failed: ${result.error.issues.map((i) => i.message).join(", ")}`,
    );
  }
  return result.data;
}

export class MinutkaClient {
  constructor(private readonly api: MinutkaApi) {}

  async chat(input: z.input<typeof chatRequest>) {
    const validated = validate(chatRequest, input, "chat request");
    const result = await this.api.chat(validated);
    return validate(chatResponse, result, "chat response");
  }
}
