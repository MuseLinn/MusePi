// @musepi/core — barrel for the native integrations in coding-agent.
export { goalManager, GoalManager } from "./goal/index.ts";
export { registerGoalTools } from "./goal/tools.ts";
export { currentGoal, GOAL_ENTRY_TYPE } from "./goal/types.ts";
export type { GoalSnapshot } from "./goal/types.ts";
export type { PersistencePort, ScopeDirs, SessionEntryLike } from "./ports.ts";
export { mergeMusepiSettings, MUSEPI_DEFAULTS, MUSEPI_SETTINGS_DOCS } from "./config/schema.ts";
export type { MusepiSettings, ResolvedMusepiSettings } from "./config/schema.ts";
