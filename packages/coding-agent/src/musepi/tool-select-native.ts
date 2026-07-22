// ============================================================
// MusePi native progressive tool disclosure (select_tools).
//
// kimi-code's toolSelect domain mapped onto pi's native deferred-tools
// wire mechanism: deferrable tools (extension-registered, plus configured
// extras) start out of the active set; the model loads them by exact name
// through the select_tools tool; loading mutates the active set, and the
// tool wrapper auto-marks the diff as `addedToolNames` on the tool result
// — the provider projection (`compat.deferredToolsMode: "kimi"`, e.g.
// moonshotai/kimi-k3) then injects full schemas at that transcript point
// and keeps them out of the cached top-level tools[].
//
// The load ledger is the session history itself (addedToolNames on tool
// results), so resume/compaction self-heal by re-folding — no separate
// persistence. The loadable-tools announcement is re-injected into the
// outgoing context view per request via the transformContext seam
// (non-persistent restatement; no fold-based diffing needed).
// ============================================================

import {
	activeNamesOnDisable,
	activeNamesOnEnable,
	foldLoadedToolNames,
	isToolSelectEnabled,
	partitionTools,
	planLoad,
	reconcileResumedActiveNames,
	renderLoadableToolsAnnouncement,
	renderLoadResult,
	SELECT_TOOLS_DESCRIPTION,
	SELECT_TOOLS_TOOL_NAME,
	type ToolEntry,
} from "@musepi/core";
import { Type } from "typebox";
import type { AgentSession } from "../core/agent-session.ts";
import type { ToolDefinition } from "../core/extensions/index.ts";
import type { SettingsManager } from "../core/settings-manager.ts";

/** Host-side runtime state for one bound session (module singleton, goalManager pattern). */
interface ToolSelectBinding {
	deferrableNames: Set<string>;
	getActiveNames: () => string[];
	setActiveNames: (names: string[]) => void;
	enabled: boolean;
}

let binding: ToolSelectBinding | null = null;

/** Musepi core tools that must always stay loaded (core interaction surface). */
const NEVER_DEFER: readonly string[] = [
	SELECT_TOOLS_TOOL_NAME,
	"create_goal",
	"get_goal",
	"update_goal",
	"set_goal_budget",
	"todo_list",
	"agent_swarm",
	"agent",
	"task_list",
	"task_output",
	"task_stop",
	"cron_list",
	"cron_create",
	"cron_delete",
	"lsp",
];

function toolEntriesOf(session: AgentSession): ToolEntry[] {
	return session.getAllTools().map((info) => ({ name: info.name, source: info.sourceInfo.source }));
}

/** Loadable right now: deferrable but not currently active. */
function loadableNow(): string[] {
	if (!binding?.enabled) return [];
	const active = new Set(binding.getActiveNames());
	return [...binding.deferrableNames].filter((name) => !active.has(name)).sort((a, b) => a.localeCompare(b));
}

/**
 * transformContext seam contribution: append the loadable-tools
 * announcement as a trailing synthetic user message on the outgoing view.
 * Returns the input untouched when the gate is off or nothing is loadable.
 */
export function transformMusepiToolSelectContext<TMessage>(messages: TMessage[]): TMessage[] {
	const loadable = loadableNow();
	if (loadable.length === 0) return messages;
	const announcement = renderLoadableToolsAnnouncement(loadable);
	return [
		...messages,
		{
			role: "user",
			content: [{ type: "text", text: announcement }],
			timestamp: Date.now(),
		} as TMessage,
	];
}

async function executeSelectTools(
	names: string[],
): Promise<{ content: { type: "text"; text: string }[]; details: Record<string, never> }> {
	if (!binding?.enabled) {
		// pi's tool-error channel is throwing (execute catch → isError result).
		throw new Error("select_tools is not available for the current model.");
	}
	const active = new Set(binding.getActiveNames());
	const plan = planLoad(names, { deferrable: binding.deferrableNames, active });
	if (plan.toLoad.length > 0) {
		// Adding to the active set lets the registered-tool wrapper mark the
		// diff as addedToolNames on this tool result — the wire projection
		// injects the full schemas at this transcript point (kimi mode).
		binding.setActiveNames([...binding.getActiveNames(), ...plan.toLoad]);
	}
	const { text, isError } = renderLoadResult(plan);
	if (isError) throw new Error(text);
	return { content: [{ type: "text", text }], details: {} };
}

/**
 * Defer newly-registered tools when the gate is on. MusePi MCP registers
 * server tools dynamically (after enumeration); with the gate on they must
 * join the deferrable set and leave the active set so they appear in the
 * loadable announcement instead of the top-level tools[].
 */
export function deferToolsViaToolSelect(names: string[]): void {
	if (!binding?.enabled || names.length === 0) return;
	for (const name of names) binding.deferrableNames.add(name);
	const active = binding.getActiveNames();
	const drop = new Set(names);
	const next = active.filter((name) => !drop.has(name));
	if (next.length !== active.length) binding.setActiveNames(next);
}

/** Remove tools from the deferrable set (MCP tool unregistered). */
export function undeferToolsViaToolSelect(names: string[]): void {
	if (!binding || names.length === 0) return;
	for (const name of names) binding.deferrableNames.delete(name);
}

export const musepiSelectToolsToolDef: ToolDefinition = {
	name: SELECT_TOOLS_TOOL_NAME,
	label: "Select Tools",
	description: SELECT_TOOLS_DESCRIPTION,
	parameters: Type.Object({
		names: Type.Array(Type.String(), {
			minItems: 1,
			description: "Exact tool names to load, taken from the latest announced tool list.",
		}),
	}),
	async execute(_toolCallId, params: { names: string[] }) {
		return executeSelectTools(params.names);
	},
};

/**
 * Bind tool-select for one session. Evaluates the gate (config + model
 * capability), shapes the active tool set accordingly, and arms the
 * announcement transformer. Mode-independent: call once per session right
 * after AgentSession construction.
 */
export function initMusepiToolSelect(session: AgentSession, settingsManager: SettingsManager): void {
	const config = settingsManager.getMusepi().toolSelect;
	const model = session.model;
	const enabled = isToolSelectEnabled(config, {
		provider: model?.provider ?? "",
		id: model?.id ?? "",
		deferredToolsMode: (model?.compat as { deferredToolsMode?: string } | undefined)?.deferredToolsMode,
	});

	const { deferrable } = partitionTools(toolEntriesOf(session), {
		defer: config.defer,
		never: NEVER_DEFER,
	});
	const deferrableNames = new Set(deferrable.map((entry) => entry.name));

	const currentActive = session.getActiveToolNames();
	if (!enabled) {
		// select_tools is registered unconditionally so the gate can flip at
		// runtime; keep it hidden while the gate is off.
		const next = activeNamesOnDisable(currentActive, SELECT_TOOLS_TOOL_NAME);
		if (next.length !== currentActive.length) session.setActiveToolsByName(next);
		binding = {
			deferrableNames,
			getActiveNames: () => session.getActiveToolNames(),
			setActiveNames: (names) => session.setActiveToolsByName(names),
			enabled: false,
		};
		return;
	}

	// Gate on: strip deferrable tools, add select_tools, and reconcile the
	// active set against the history ledger so resumed sessions keep their
	// previously loaded tools (the active set itself is not persisted).
	const stripped = activeNamesOnEnable(currentActive, deferrableNames, SELECT_TOOLS_TOOL_NAME);
	const loadedFromHistory = foldLoadedToolNames(session.messages);
	const reconciled = reconcileResumedActiveNames(stripped, deferrableNames, loadedFromHistory);
	session.setActiveToolsByName(reconciled);

	binding = {
		deferrableNames,
		getActiveNames: () => session.getActiveToolNames(),
		setActiveNames: (names) => session.setActiveToolsByName(names),
		enabled: true,
	};
}
