import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { startTransports } from "../../../src/runtime/transport-startup.js";

describe("D0.4: transport startup", () => {
  it("starts the scheduler once without waiting for Telegram polling to finish", async () => {
    const startScheduler = vi.fn(async () => undefined);
    const polling = new Promise<void>(() => undefined);
    const launchTelegram = vi.fn(() => polling);

    await expect(startTransports({ startScheduler, launchTelegram })).resolves.toEqual({
      launchCompleted: polling,
    });
    expect(startScheduler).toHaveBeenCalledTimes(1);
    expect(launchTelegram).toHaveBeenCalledTimes(1);
    expect(startScheduler.mock.invocationCallOrder[0]).toBeLessThan(launchTelegram.mock.invocationCallOrder[0]!);
  });

  it("does not await bot.launch in the production entrypoint", () => {
    const source = readFileSync("src/runtime/serve.ts", "utf8");

    expect(source).not.toMatch(/await\s+bot\s*!?\.launch\s*\(/u);
  });
});
