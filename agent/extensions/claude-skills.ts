// Auto-discover project-level .claude/skills directories (like .agents/skills)
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

function findGitRepoRoot(startDir: string): string | null {
  let dir = resolve(startDir);
  while (true) {
    if (existsSync(join(dir, ".git"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

function collectClaudeSkillDirs(startDir: string): string[] {
  const skillDirs: string[] = [];
  const resolvedStartDir = resolve(startDir);
  const gitRepoRoot = findGitRepoRoot(resolvedStartDir);
  // Exclude user-level (already in settings)
  const userClaudeSkills = join(homedir(), ".claude", "skills");
  let dir = resolvedStartDir;

  while (true) {
    const claudeSkills = join(dir, ".claude", "skills");
    // Don't duplicate user-level
    if (resolve(claudeSkills) !== resolve(userClaudeSkills)) {
      skillDirs.push(claudeSkills);
    }

    if (gitRepoRoot && dir === gitRepoRoot) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return skillDirs;
}

export default function (pi: ExtensionAPI) {
  pi.on("resources_discover", async (event) => {
    return {
      skillPaths: collectClaudeSkillDirs(event.cwd),
    };
  });
}
