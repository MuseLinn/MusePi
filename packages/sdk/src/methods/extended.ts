/**
 * Extended domains — method signatures + auth levels locked now, schemas
 * intentionally loose (broad objects) so Phase 2 stays shippable. Tighten as
 * the daemon implements each domain.
 *
 * Domains: file, terminal, goals/plan/todo, task, stats, autoresearch.
 */
import { Type } from "@sinclair/typebox";
import type { MethodEntry } from "../index";

// ── file ────────────────────────────────────────────────────────────────────

export const fileRead = {
	method: "file.read",
	auth: "local",
	params: Type.Object({ path: Type.String(), range: Type.Optional(Type.String()) }),
	result: Type.Any({ description: "File content + meta" }),
	impl: "tools/read.ts",
} satisfies MethodEntry;

export const fileWrite = {
	method: "file.write",
	auth: "local",
	params: Type.Object({ path: Type.String(), content: Type.String(), mode: Type.Optional(Type.String()) }),
	result: Type.Any({ description: "WriteResult" }),
	impl: "tools/write.ts",
} satisfies MethodEntry;

export const fileTree = {
	method: "file.tree",
	auth: "session",
	params: Type.Object({ path: Type.Optional(Type.String()), depth: Type.Optional(Type.Number()) }),
	result: Type.Any({ description: "DirectoryTree (workspace-tree.ts, per-dir cap)" }),
	impl: "workspace-tree.ts buildDirectoryTree()",
} satisfies MethodEntry;

// ── terminal ────────────────────────────────────────────────────────────────

export const terminalOpen = {
	method: "terminal.open",
	auth: "local",
	params: Type.Object({ cwd: Type.Optional(Type.String()) }),
	result: Type.Any({ description: "Terminal handle" }),
	impl: "terminal (runtime)",
} satisfies MethodEntry;

export const terminalWrite = {
	method: "terminal.write",
	auth: "local",
	params: Type.Object({ terminalId: Type.String(), data: Type.String() }),
	result: Type.Any({}),
	impl: "terminal (runtime)",
} satisfies MethodEntry;

// ── goals / plan / todo ─────────────────────────────────────────────────────

export const goalsList = {
	method: "goals.list",
	auth: "session",
	params: Type.Object({}),
	result: Type.Any({ description: "Goal state machine snapshot" }),
	impl: "goals/ (state machine)",
} satisfies MethodEntry;

export const todoList = {
	method: "todo.list",
	auth: "session",
	params: Type.Object({ phase: Type.Optional(Type.String()) }),
	result: Type.Any({ description: "Todo phase model" }),
	impl: "todo (phase model)",
} satisfies MethodEntry;

// ── task (subagent orchestration) ───────────────────────────────────────────

export const taskSubmit = {
	method: "task.submit",
	auth: "session",
	params: Type.Object({ prompt: Type.String(), agent: Type.Optional(Type.String()) }),
	result: Type.Any({ description: "Task handle + subagent id" }),
	impl: "task runner / subagents (runtime)",
} satisfies MethodEntry;

export const taskProgress = {
	method: "task.progress",
	auth: "session",
	params: Type.Object({ taskId: Type.String() }),
	result: Type.Any({ description: "SubagentProgressPayload" }),
	impl: "event bus task:subagent:progress (runtime)",
} satisfies MethodEntry;

// ── stats ───────────────────────────────────────────────────────────────────

export const statsUsage = {
	method: "stats.usage",
	auth: "local",
	params: Type.Object({ range: Type.Optional(Type.String()) }),
	result: Type.Any({ description: "Usage/cost rows (@musepi/musepi-stats data)" }),
	impl: "musepi-stats aggregator",
} satisfies MethodEntry;

// ── autoresearch (experiment management, first-party) ───────────────────────

export const autoresearchDashboard = {
	method: "autoresearch.dashboard",
	auth: "session",
	params: Type.Object({}),
	result: Type.Any({ description: "ExperimentState + runs (keep/discard/crash/checks_failed)" }),
	impl: "autoresearch/state.ts + storage.ts",
} satisfies MethodEntry;

export const autoresearchInit = {
	method: "autoresearch.init",
	auth: "local",
	params: Type.Object({ goal: Type.String(), metric: Type.Optional(Type.String()) }),
	result: Type.Any({ description: "ExperimentState" }),
	impl: "autoresearch/tools/init-experiment.ts",
} satisfies MethodEntry;

export const autoresearchRun = {
	method: "autoresearch.run",
	auth: "local",
	params: Type.Object({ runId: Type.Optional(Type.String()) }),
	result: Type.Any({ description: "RunExperimentResult" }),
	impl: "autoresearch/tools/run-experiment.ts",
} satisfies MethodEntry;

export const extendedMethods: MethodEntry[] = [
	fileRead,
	fileWrite,
	fileTree,
	terminalOpen,
	terminalWrite,
	goalsList,
	todoList,
	taskSubmit,
	taskProgress,
	statsUsage,
	autoresearchDashboard,
	autoresearchInit,
	autoresearchRun,
];
