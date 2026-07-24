// ============================================================
// MusePi native memory integration — host seam.
//
// The engine (markdown store, BM25 recall, budgeted injection) lives
// in @musepi/core/memory with zero pi imports. This module owns the
// fork-side glue:
//   1. the `memory` tool (search / retain / edit);
//   2. the one-shot startup injection: the first transformContext call
//      of a session appends the budgeted memory block as a trailing
//      synthetic user message (non-persistent — resume re-injects at
//      process start, nothing is written into the transcript);
//   3. the enable gate: disabled = no injection and the tool is
//      stripped from the active set (zero model surface);
//   4. the /memory command surface (view/stats/clear/enable/disable) —
//      see handleMusepiMemoryCommand; view reuses buildMemoryInjection
//      so the payload on screen is exactly what startup injects.
//
// Data root: <agentDir>/memory/ (global/MEMORY.md + projects/<pid>/
// MEMORY.md, pid = sha256(abs cwd)[:12]). Files are authoritative and
// human-editable; recall re-reads them on every query.
// ============================================================

import { existsSync, readFileSync, statSync } from "node:fs";
import {
	buildMemoryInjection,
	editEntry,
	estimateTokens,
	MEMORY_SECTIONS,
	type MemorySection,
	memoryPaths,
	memorySkeleton,
	retainEntry,
	searchMemory,
	tokenize,
	writeMemoryFile,
} from "@musepi/core";
import { Type } from "typebox";
import { getAgentDir } from "../config.ts";
import type { AgentSession } from "../core/agent-session.ts";
import type { ToolDefinition } from "../core/extensions/index.ts";
import type { SettingsManager } from "../core/settings-manager.ts";

const MEMORY_TOOL_NAME = "memory";

interface MemoryBinding {
	enabled: boolean;
	cwd: string;
	dataDir: string;
	scope: "project" | "global";
	caps: { project: number; global: number };
	/** One-shot startup injection flag (per session process). */
	injected: boolean;
}

let binding: MemoryBinding | null = null;

/** Test hook: install a binding directly. */
export function initMusepiMemoryForTest(testBinding: MemoryBinding | null): void {
	binding = testBinding;
}

function requireBinding(): MemoryBinding {
	if (!binding || !binding.enabled) {
		throw new Error(
			"memory is not enabled for this session. Set musepi.memory.enabled: true in settings to turn on long-term memory.",
		);
	}
	return binding;
}

const MEMORY_DESCRIPTION = `Long-term memory over human-readable markdown files (project-scoped, plus an optional global file).

Operations:
- search: BM25-recall memory entries relevant to a query. Returns matching lines with their source artifact path and line number — cite these when memory influences your plan.
- retain: append one durable fact (decision, constraint, pitfall, workflow) to the project memory. Adjacent duplicates are skipped automatically. Keep entries short and factual.
- edit: rewrite one memory line, addressed by a unique anchor substring of its current text.

Memory is heuristic, not authoritative: verify against the repository before acting on it.`;

export const musepiMemoryToolDef: ToolDefinition = {
	name: MEMORY_TOOL_NAME,
	label: "Memory",
	description: MEMORY_DESCRIPTION,
	parameters: Type.Object({
		operation: Type.Union([Type.Literal("search"), Type.Literal("retain"), Type.Literal("edit")], {
			description: "search = recall entries; retain = append a fact; edit = rewrite one line by anchor",
		}),
		query: Type.Optional(Type.String({ description: "search: the recall query" })),
		text: Type.Optional(Type.String({ description: "retain: the fact to store (one line)" })),
		section: Type.Optional(
			Type.String({
				description: `retain: target section, one of: ${MEMORY_SECTIONS.join(", ")} (default "Durable knowledge")`,
			}),
		),
		anchor: Type.Optional(Type.String({ description: "edit: unique substring of the line to rewrite" })),
		replacement: Type.Optional(Type.String({ description: "edit: the new line content" })),
		scope: Type.Optional(
			Type.Union([Type.Literal("project"), Type.Literal("global")], {
				description: "retain/edit target file (default project); search always covers every injected scope",
			}),
		),
	}),
	async execute(_toolCallId, params) {
		const b = requireBinding();
		const paths = memoryPaths(b.dataDir, b.cwd);
		const input = params as {
			operation: "search" | "retain" | "edit";
			query?: string;
			text?: string;
			section?: string;
			anchor?: string;
			replacement?: string;
			scope?: "project" | "global";
		};
		const text = (value: string): { content: { type: "text"; text: string }[]; details: Record<string, never> } => ({
			content: [{ type: "text", text: value }],
			details: {},
		});

		switch (input.operation) {
			case "search": {
				if (!input.query?.trim()) throw new Error("memory search: query is required.");
				const sources: Array<{ file: string; kind: "project" | "global" }> = [
					{ file: paths.projectFile, kind: "project" },
				];
				if (b.scope === "global") sources.push({ file: paths.globalFile, kind: "global" });
				const hits = searchMemory(sources, input.query);
				if (hits.length === 0) {
					return text(
						"No memory entries matched. The store may be empty or the query too specific — retain durable facts as you learn them.",
					);
				}
				const lines = hits.map((hit) => `${hit.file}:${hit.line}: ${hit.text}`);
				return text(
					`${lines.join("\n")}\n\nThese entries are heuristics, not facts — verify against the repository, and cite the path:line when you use them.`,
				);
			}
			case "retain": {
				if (!input.text?.trim()) throw new Error("memory retain: text is required.");
				const target =
					input.scope === "global"
						? { file: paths.globalFile, kind: "global" as const }
						: { file: paths.projectFile, kind: "project" as const };
				const section = (input.section?.trim() || "Durable knowledge") as MemorySection;
				if (!MEMORY_SECTIONS.includes(section)) {
					throw new Error(`memory retain: unknown section "${section}". One of: ${MEMORY_SECTIONS.join(", ")}.`);
				}
				const result = retainEntry(target.file, target.kind, input.text, section);
				return text(
					result.appended
						? `Retained at ${target.file}:${result.line} [${section}].`
						: `Skipped — the last entry in [${section}] already says exactly this (${target.file}:${result.line}).`,
				);
			}
			case "edit": {
				if (!input.anchor?.trim()) throw new Error("memory edit: anchor is required.");
				if (input.replacement === undefined) throw new Error("memory edit: replacement is required.");
				const target =
					input.scope === "global"
						? { file: paths.globalFile, kind: "global" as const }
						: { file: paths.projectFile, kind: "project" as const };
				const result = editEntry(target.file, target.kind, input.anchor, input.replacement);
				return text(`Rewrote ${target.file}:${result.line}.`);
			}
		}
	},
};

/**
 * transformContext seam contribution: on the first outgoing request of
 * the session, append the budgeted memory block as a trailing synthetic
 * user message. Non-persistent and one-shot — later requests pass
 * through untouched.
 */
export function transformMusepiMemoryContext<TMessage>(messages: TMessage[]): TMessage[] {
	if (!binding?.enabled || binding.injected) return messages;
	binding.injected = true;
	const block = buildMemoryInjection({
		dataDir: binding.dataDir,
		cwd: binding.cwd,
		scope: binding.scope,
		caps: binding.caps,
	});
	if (block === null) return messages;
	return [
		...messages,
		{
			role: "user",
			content: [{ type: "text", text: block }],
			timestamp: Date.now(),
		} as TMessage,
	];
}

/**
 * Bind memory for one session. The binding always exists after this call —
 * `enabled: false` only means the tool is stripped from the active set and
 * the startup injection is skipped; the /memory command surface (view/stats/
 * clear) stays usable so the feature is discoverable. Mode-independent:
 * call once per session right after AgentSession construction, and again
 * after toggling musepi.memory.enabled (hot switch — a fresh bind re-arms
 * the one-shot injection for the next turn).
 */
export function initMusepiMemory(session: AgentSession, settingsManager: SettingsManager): void {
	const config = settingsManager.getMusepi().memory;
	const active = session.getActiveToolNames();
	if (!config.enabled) {
		binding = {
			enabled: false,
			cwd: session.sessionManager.getCwd(),
			dataDir: getAgentDir(),
			scope: config.scope,
			caps: config.caps,
			injected: false,
		};
		if (active.includes(MEMORY_TOOL_NAME)) {
			session.setActiveToolsByName(active.filter((name) => name !== MEMORY_TOOL_NAME));
		}
		return;
	}
	binding = {
		enabled: true,
		cwd: session.sessionManager.getCwd(),
		dataDir: getAgentDir(),
		scope: config.scope,
		caps: config.caps,
		injected: false,
	};
	if (!active.includes(MEMORY_TOOL_NAME)) {
		session.setActiveToolsByName([...active, MEMORY_TOOL_NAME]);
	}
}

// =============================================================================
// /memory command surface
// =============================================================================

/** Host-provided context for the /memory command (interactive layer). */
export interface MusepiMemoryCommandContext {
	/** clear confirmation — the interactive layer prompts before calling. */
	confirmed?: boolean;
	/**
	 * enable/disable: write musepi.memory.enabled to settings and re-bind
	 * (hot switch). Absent outside an interactive session.
	 */
	setEnabled?: (enabled: boolean) => void;
}

const MEMORY_USAGE = "Usage: /memory [view|stats|clear <project|global|all>|enable|disable]";

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	return `${(bytes / 1024).toFixed(1)} KB`;
}

/** Entry lines = non-empty, non-heading (same granularity as BM25 documents). */
function countEntries(content: string): number {
	return content.split("\n").filter((line) => line.trim().length > 0 && !line.trimStart().startsWith("#")).length;
}

function renderFileStats(label: string, file: string, inScope: boolean): string[] {
	const lines: string[] = [];
	const scopeNote = inScope ? "" : " (not injected: scope = project)";
	if (!existsSync(file)) {
		lines.push(`${label}: ${file}${scopeNote}`);
		lines.push("  not created yet — no entries retained");
		return lines;
	}
	const content = readFileSync(file, "utf-8");
	const entries = countEntries(content);
	const terms = new Set(content.split("\n").flatMap((line) => tokenize(line)));
	lines.push(`${label}: ${file}${scopeNote}`);
	lines.push(
		`  ${entries} entries · ${formatBytes(statSync(file).size)} · ~${estimateTokens(content)} tokens · ${terms.size} distinct terms`,
	);
	return lines;
}

/** `/memory view` — the exact block the startup injection would send now. */
function renderView(b: MemoryBinding): string {
	if (!b.enabled) {
		return [
			"Memory is disabled (musepi.memory.enabled = false) — nothing is injected.",
			"Run /memory enable to turn it on for this session and future ones.",
		].join("\n");
	}
	// Same constructor as the startup injection (transformMusepiMemoryContext) —
	// a fresh read of the files, so edits since session start are reflected.
	const block = buildMemoryInjection({ dataDir: b.dataDir, cwd: b.cwd, scope: b.scope, caps: b.caps });
	if (block === null) {
		return [
			"Memory payload is empty — no entries beyond the skeleton, so nothing was injected at session start.",
			"Use the memory tool (retain) or edit MEMORY.md directly to add durable facts.",
		].join("\n");
	}
	return `Memory Injection Payload (as constructed for session start):\n\n${block}`;
}

function renderStats(b: MemoryBinding): string {
	const paths = memoryPaths(b.dataDir, b.cwd);
	const lines: string[] = [];
	lines.push(
		`Memory: ${b.enabled ? "enabled" : "disabled"} · scope = ${b.scope} · budgets: project ${b.caps.project} / global ${b.caps.global} tokens`,
	);
	lines.push("");
	lines.push(...renderFileStats("Project", paths.projectFile, true));
	lines.push(...renderFileStats("Global", paths.globalFile, b.scope === "global"));
	lines.push("");
	lines.push("BM25 index: rebuilt in memory per query (no persistent cache) — files are the source of truth.");
	return lines.join("\n");
}

function clearMemory(b: MemoryBinding, target: string): string {
	const paths = memoryPaths(b.dataDir, b.cwd);
	const reset = (file: string, kind: "project" | "global", label: string): string => {
		const existed = existsSync(file) && countEntries(readFileSync(file, "utf-8")) > 0;
		writeMemoryFile(file, memorySkeleton(kind));
		return existed
			? `${label} memory reset to the empty skeleton (${file}).`
			: `${label} memory was already empty (${file}).`;
	};
	switch (target) {
		case "project":
			return reset(paths.projectFile, "project", "Project");
		case "global":
			return reset(paths.globalFile, "global", "Global");
		case "all":
			return [reset(paths.projectFile, "project", "Project"), reset(paths.globalFile, "global", "Global")].join(
				"\n",
			);
		default:
			return `Unknown clear target "${target}". Usage: /memory clear <project|global|all>`;
	}
}

/**
 * Handle `/memory [view|stats|clear <target>|enable|disable]`. Returns the
 * text to display. `clear` is destructive — the interactive layer confirms
 * first and passes { confirmed: true }; without it this only reports what
 * would happen.
 */
export function handleMusepiMemoryCommand(args: string, ctx: MusepiMemoryCommandContext = {}): string {
	const [action = "", target = ""] = args.trim().split(/\s+/, 2);

	if (action === "enable" || action === "disable") {
		if (!ctx.setEnabled) return `Memory ${action} is only available in an interactive session.`;
		const enable = action === "enable";
		ctx.setEnabled(enable);
		return enable
			? [
					"Memory enabled — musepi.memory.enabled = true written to settings.",
					"Hot-switched: the memory tool is active now and the payload injects on the next agent turn.",
				].join("\n")
			: [
					"Memory disabled — musepi.memory.enabled = false written to settings.",
					"Hot-switched: the memory tool is removed and no further injection happens this session",
					"(the non-persistent block already sent earlier cannot be unsent).",
				].join("\n");
	}

	if (!binding) return "Memory is not initialized for this session.";
	const b = binding;

	switch (action) {
		case "":
		case "view":
			return renderView(b);
		case "stats":
			return renderStats(b);
		case "clear": {
			if (!target) return "Usage: /memory clear <project|global|all>";
			if (!["project", "global", "all"].includes(target)) {
				return `Unknown clear target "${target}". Usage: /memory clear <project|global|all>`;
			}
			if (!ctx.confirmed) {
				return `Clearing ${target} memory resets it to the empty skeleton — confirmation required.`;
			}
			return clearMemory(b, target);
		}
		default:
			return `Unknown /memory action "${action}". ${MEMORY_USAGE}`;
	}
}
