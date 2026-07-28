import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export type SyntheticPilotKnowledgeBase = {
  root: string;
  documentCount: number;
  corePaths: string[];
  deepDocumentPath: string;
  wideDocumentPath: string;
};

/** Builds a committed, owner-neutral fixture in a temporary directory. */
export function createSyntheticPilotKnowledgeBase(
  options: { wideDocuments?: number } = {},
): SyntheticPilotKnowledgeBase {
  const root = mkdtempSync(join(tmpdir(), "synthetic-pilot-knowledge-base-"));
  const paths: string[] = [];
  const write = (path: string, content: string): void => {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
    paths.push(path);
  };

  write("INDEX.md", [
    "# Synthetic owner context",
    "- [Memory](10_user_memory/)",
    "- [Knowledge](30_knowledge/)",
    "- [Projects](40_projects/)",
    "- [Assistant memory](90_agent_memory/)",
    "",
  ].join("\n"));
  write("10_user_memory/INDEX.md", [
    "# Memory navigation",
    "- `01_persona.md`",
    "- `02_goals_and_priorities.md`",
    "- `06_tags_and_classifications.md`",
    "",
  ].join("\n"));
  write("10_user_memory/01_persona.md", "# Synthetic persona\nPrefer concise, verifiable answers.\n");
  write("10_user_memory/02_goals_and_priorities.md", "# Synthetic goals\nShip the test fixture safely.\n");
  write("10_user_memory/06_tags_and_classifications.md", "# Synthetic tags\nfixture, context, testing\n");

  write("30_knowledge/INDEX.md", "# Knowledge navigation\n- [Library](library/)\n");
  const wideDocuments = options.wideDocuments ?? 48;
  for (let index = 0; index < wideDocuments; index += 1) {
    write(`30_knowledge/library/note-${String(index).padStart(3, "0")}.md`, `# Synthetic note ${index}\nNeutral fixture content ${index}.\n`);
  }

  write("40_projects/INDEX.md", "# Project navigation\n- `00_проекты.md`\n- [Alpha](alpha/)\n");
  write("40_projects/00_проекты.md", "# Synthetic projects\nAlpha is the active fixture project.\n");
  write("40_projects/alpha/INDEX.md", "# Alpha navigation\n- [Planning](planning/)\n");
  write("40_projects/alpha/planning/INDEX.md", "# Planning navigation\n- [Design](design/)\n");
  write("40_projects/alpha/planning/design/INDEX.md", "# Design navigation\n- [Archive](archive/)\n");
  const deepDocumentPath = "40_projects/alpha/planning/design/archive/deep-note.md";
  write(deepDocumentPath, "# Deep synthetic note\nBounded tree traversal fixture.\n");

  write("90_agent_memory/INDEX.md", "# Assistant memory navigation\n- `soul.md`\n");
  write("90_agent_memory/soul.md", "# Synthetic assistant character\nBe careful and explicit.\n");

  return {
    root,
    documentCount: paths.length,
    corePaths: [
      "context/10_user_memory/01_persona.md",
      "context/10_user_memory/02_goals_and_priorities.md",
      "context/10_user_memory/06_tags_and_classifications.md",
      "context/40_projects/00_проекты.md",
      "context/90_agent_memory/soul.md",
    ],
    deepDocumentPath: `context/${deepDocumentPath}`,
    wideDocumentPath: "context/30_knowledge/library/note-047.md",
  };
}
