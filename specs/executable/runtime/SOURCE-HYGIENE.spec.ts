import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const sourceRoots = ["src", "specs", "migrations", "vault/assistant", "docs"];
const sourceExtensions = new Set([".ts", ".md", ".json", ".sql"]);
const skippedDirectories = new Set(["generated"]);

function sourceFiles(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = join(path, entry.name);
    if (entry.isDirectory()) return skippedDirectories.has(entry.name) ? [] : sourceFiles(entryPath);
    return sourceExtensions.has(entry.name.slice(entry.name.lastIndexOf("."))) ? [entryPath] : [];
  });
}

function controlCharacterOffsets(path: string): number[] {
  const source = readFileSync(path);
  return [...source.entries()]
    .filter(([, byte]) => (byte < 0x20 && byte !== 0x09 && byte !== 0x0a) || byte === 0x7f)
    .map(([offset]) => offset);
}

describe("SOURCE-HYGIENE: repository source files", () => {
  it("contain no control characters except tabs and line feeds", () => {
    const violations = sourceRoots.flatMap((root) => sourceFiles(root).flatMap((path) =>
      controlCharacterOffsets(path).map((offset) => `${path}:${offset}`),
    ));
    expect(violations, "control characters found at file:byte-offset").toEqual([]);
  });
});
