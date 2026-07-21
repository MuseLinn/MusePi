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
//      stripped from the active set (zero surface).
//
// Data root: <agentDir>/memory/ (global/MEMORY.md + projects/<pid>/
// MEMORY.md, pid = sha256(abs cwd)[:12]). Files are authoritative and
// human-editable; recall re-reads them on every query.
// ============================================================

import {
	buildMemoryInjection,
	editEntry,
	MEMORY_SECTIONS,
	type MemorySection,
	memoryPaths,
	retainEntry,
	searchMemory,
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
 * Bind memory for one session. Disabled = no injection and the memory
 * tool removed from the active set. Mode-independent: call once per
 * session right after AgentSession construction (initMusepiLsp pattern).
 */
export function initMusepiMemory(session: AgentSession, settingsManager: SettingsManager): void {
	const config = settingsManager.getMusepi().memory;
	if (!config.enabled) {
		binding = null;
		const active = session.getActiveToolNames();
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
}
