import { describe, expect, it } from "vitest";
import { migrationChecksumMatches } from "../../../src/infrastructure/postgres/postgres-migrator.js";

const original0074Checksum = "9caf17a70a9f008e1a57195dcb986d82a4eb3d7e9062b11586a76914359e4ee0";
const corrected0074Checksum = "cf7f1f69bcadd4c7325d8d66cf3708b6188f647f8a7bcccdaf5b2a13b40d84de";

describe("SPEC-POSTGRES-MIGRATION-CHECKSUM-COMPATIBILITY-001: immutable historical checksum compatibility", () => {
  it("accepts the known pre-production 0074 bytes without rewriting the migration ledger", () => {
    expect(migrationChecksumMatches("0074", original0074Checksum, corrected0074Checksum)).toBe(true);
  });

  it("still rejects unknown drift and does not make compatibility global", () => {
    expect(migrationChecksumMatches("0074", "unknown", corrected0074Checksum)).toBe(false);
    expect(migrationChecksumMatches("0073", original0074Checksum, corrected0074Checksum)).toBe(false);
  });

  it("accepts the current checksum for every migration", () => {
    expect(migrationChecksumMatches("0074", corrected0074Checksum, corrected0074Checksum)).toBe(true);
    expect(migrationChecksumMatches("0079", "same", "same")).toBe(true);
  });
});
