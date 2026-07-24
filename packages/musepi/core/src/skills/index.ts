// ============================================================
// Skills — public API
// ============================================================
// loadSkillsForCwd(cwd, options): seven-scope Agent Skills scan (pi-native
// dirs first, then Kimi Code compat + cross-tool), fed into subagent
// sessions via resourceLoader.getSkills; options.scope carries the host
// layout (the fork passes .musepi), options.kimiCodeCompat gates the two
// Kimi Code compat dirs.
// listCompatSkillDirs(cwd, scope, options): the dirs pi's own
// package-manager does NOT scan — the main session registers these as
// extra auto-discovered skill dirs after its pi-native ones, unifying the
// main session onto the same seven-scope layout.
// listExistingSkillDirs(cwd, scope): existing skills dirs only, for the
// main session's resources_discover hook (pi loads them with its own
// scanner).

export {
  loadSkillsForCwd,
  listSkillRootDirs,
  listExistingSkillDirs,
  listCompatSkillDirs,
  listDiscoverableSkillFiles,
  findProjectRoot,
  clearSkillsCache,
} from "./scanner.ts";
export type {
  KimiSkill,
  SkillDiagnostic,
  LoadSkillsResult,
  LoadSkillsForCwdOptions,
  SkillRootDir,
  SkillScope,
} from "./scanner.ts";
export { parseFrontmatter, fallbackDescription } from "./frontmatter.ts";
