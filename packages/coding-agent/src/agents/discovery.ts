/**
 * Agent discovery: scan filesystem for agent definitions.
 *
 * Discovery hierarchy (highest to lowest precedence):
 *   1. Project agents — `.musepi/agents/*.md`
 *   2. User agents — `~/.musepi/agent/agents/*.md`
 *   3. Bundled agents — hardcoded definitions from bundled.ts
 *
 * When the same agent name exists at multiple levels, the higher-precedence
 * source wins (project overrides user, user overrides bundled).
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentDefinition, AgentSource } from "@musepi/core";
import { getBundledAgentDefs } from "./bundled.ts";
import { parseAgentMarkdown } from "./parse.ts";

/** Results from a full discovery scan. */
export interface DiscoverAgentsResult {
	agents: AgentDefinition[];
}

/**
 * Discover all agents across all sources.
 * Returns a deduplicated list with project > user > bundled precedence.
 */
export function discoverAgents(projectDir?: string): DiscoverAgentsResult {
	const byName = new Map<string, AgentDefinition>();

	// 1. Bundled (lowest precedence — only inserted if not already present)
	for (const spec of getBundledAgentDefs()) {
		if (!byName.has(spec.name)) {
			byName.set(spec.name, {
				...spec,
				source: "bundled",
				filePath: undefined,
			});
		}
	}

	// 2. User agents (middle precedence)
	const userDir = join(homedir(), ".musepi", "agent", "agents");
	if (existsSync(userDir)) {
		loadFromDirectory(userDir, "user", byName);
	}

	// 3. Project agents (highest precedence)
	if (projectDir) {
		const projectDirResolved = resolve(projectDir, ".musepi", "agents");
		if (existsSync(projectDirResolved)) {
			loadFromDirectory(projectDirResolved, "project", byName);
		}
	}

	return { agents: [...byName.values()] };
}

/**
 * Scan a directory for `.md` agent definition files and merge them
 * into the name-indexed map (overwriting existing entries).
 */
function loadFromDirectory(
	dir: string,
	source: Extract<AgentSource, "user" | "project">,
	byName: Map<string, AgentDefinition>,
): void {
	try {
		const entries = readDir(dir);
		for (const entry of entries) {
			if (!entry.endsWith(".md")) continue;
			const filePath = join(dir, entry);
			try {
				const content = readFileSync(filePath, "utf-8");
				const result = parseAgentMarkdown(content, entry);
				if (!result) continue;

				const def: AgentDefinition = {
					name: result.name,
					description: result.description,
					systemPrompt: result.systemPrompt,
					tools: result.tools ?? "*",
					spawns: result.spawns,
					model: result.model,
					thinkingLevel: result.thinkingLevel,
					prewalk: result.prewalk,
					source,
					filePath,
				};

				// Higher-precedence source overwrites lower
				byName.set(def.name, def);
			} catch {
				// skip unreadable files
			}
		}
	} catch {
		// skip unreadable directories
	}
}

/**
 * Read directory entries (sync). Tolerates ENOENT/ENOTDIR.
 */
function readDir(dir: string): string[] {
	try {
		const { readdirSync } = require("node:fs") as typeof import("node:fs");
		return readdirSync(dir);
	} catch {
		return [];
	}
}

/**
 * List agent names available in the bundled set.
 */
export function listBundledAgentNames(): string[] {
	return getBundledAgentDefs().map((a) => a.name);
}
