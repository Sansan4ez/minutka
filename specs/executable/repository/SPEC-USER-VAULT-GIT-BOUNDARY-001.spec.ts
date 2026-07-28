import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const userVaultPath = "vault/user/knowledge_base";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function trackedUserVaultFiles(cwd = process.cwd()): string[] {
  return git(cwd, ["ls-files", "--", userVaultPath]).trim().split("\n").filter(Boolean);
}

describe("SPEC-USER-VAULT-GIT-BOUNDARY-001: private owner vault stays outside application Git", () => {
  it("tracks no files, navigation documents, or symlink under the local user vault bridge", () => {
    expect(trackedUserVaultFiles()).toEqual([]);
  });

  it("detects a file added with force despite the repository ignore rule", () => {
    const root = mkdtempSync(join(tmpdir(), "user-vault-git-boundary-"));
    git(root, ["init", "--quiet"]);
    mkdirSync(join(root, userVaultPath), { recursive: true });
    writeFileSync(join(root, ".gitignore"), `${userVaultPath}/\n`);
    writeFileSync(join(root, userVaultPath, "INDEX.md"), "private navigation\n");

    expect(trackedUserVaultFiles(root)).toEqual([]);
    git(root, ["add", "--force", `${userVaultPath}/INDEX.md`]);
    expect(trackedUserVaultFiles(root)).toEqual([`${userVaultPath}/INDEX.md`]);
  });
});
