/**
 * Agent Registry — runtime state for discovered agents.
 *
 * Manages enable/disable state, model overrides, and prewalk overrides
 * for all discovered agents. These override the definition-level defaults
 * and are driven by the `musepi.agents.*` settings.
 *
 * The Registry is populated by `discoverAgents()` and operates in-memory;
 * persistence of overrides is handled through SettingsManager (settings.json).
 */

import type { AgentDefinition, AgentSource, ResolvedMusepiSettings } from "@musepi/core";
import { discoverAgents } from "./discovery.ts";

export interface AgentRegistryEntry {
	/** The agent definition (immutable from source). */
	definition: AgentDefinition;
	/** Whether the agent is enabled (default true). */
	enabled: boolean;
	/** Runtime model override (from settings). Overrides `definition.model` when set. */
	runtimeModelOverride?: string;
	/** Runtime prewalk override (from settings). Overrides `definition.prewalk` when set. */
	runtimePrewalkOverride?: boolean;
}

/**
 * Agent Registry — single source of truth for all agents.
 */
export class AgentRegistry {
	private _entries = new Map<string, AgentRegistryEntry>();
	private _projectDir?: string;

	/** Initialize registry with a full discovery scan. */
	initialize(projectDir?: string): void {
		this._projectDir = projectDir;
		const result = discoverAgents(projectDir);
		this._entries.clear();
		for (const def of result.agents) {
			this._entries.set(def.name, {
				definition: def,
				enabled: true,
			});
		}
	}

	/** Apply settings overrides (enable/disable, model overrides, prewalk). */
	applySettings(settings: ResolvedMusepiSettings["agents"]): void {
		const disabledSet = new Set(settings.disabledAgents ?? []);

		for (const [name, entry] of this._entries) {
			entry.enabled = !disabledSet.has(name);
			entry.runtimeModelOverride = settings.agentModelOverrides?.[name];
			entry.runtimePrewalkOverride = settings.agentPrewalk?.[name];
		}
	}

	/** Re-scan filesystem and re-apply settings. */
	refresh(settings: ResolvedMusepiSettings["agents"]): void {
		this.initialize(this._projectDir);
		this.applySettings(settings);
	}

	/** Get all entries, optionally filtered by source. */
	list(source?: AgentSource): AgentRegistryEntry[] {
		const all = [...this._entries.values()];
		if (source) return all.filter((e) => e.definition.source === source);
		return all;
	}

	/** Get all enabled entries. */
	listEnabled(): AgentRegistryEntry[] {
		return [...this._entries.values()].filter((e) => e.enabled);
	}

	/** Get a single entry by name. */
	get(name: string): AgentRegistryEntry | undefined {
		return this._entries.get(name);
	}

	/** Check if an agent exists and is enabled. */
	isEnabled(name: string): boolean {
		return this._entries.get(name)?.enabled ?? false;
	}

	/** Number of registered agents. */
	get size(): number {
		return this._entries.size;
	}

	/** Get by source for tab filtering. */
	listBySource(): Record<AgentSource, AgentRegistryEntry[]> {
		const result: Record<AgentSource, AgentRegistryEntry[]> = {
			bundled: [],
			user: [],
			project: [],
			extension: [],
		};
		for (const entry of this._entries.values()) {
			const source = entry.definition.source;
			if (result[source]) result[source].push(entry);
		}
		return result;
	}
}

/** Global singleton registry. */
export const agentRegistry = new AgentRegistry();
