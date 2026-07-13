import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

function source(path: string) { return readFileSync(path, "utf8"); }

describe("SPEC-IMPORT-BOUNDARIES-001: HTTP and SDK layering", () => {
  it("keeps contracts and SDK independent of HTTP and application implementation", () => {
    const contracts = source("src/contracts/minutka-api.ts");
    const sdk = `${source("src/client/sdk/minutka-client.ts")}\n${source("src/client/sdk/http-transport.ts")}`;
    const service = source("src/application/minutka-service.ts");
    for (const value of [contracts, sdk]) expect(value).not.toMatch(/from\s+["'][^"']*(server\/http|application\/minutka-service|telegraf|\bpg\b)/);
    expect(service).not.toMatch(/from\s+["'][^"']*(node:http|server\/http|auth\.js)/);
  });
});
