/**
 * Agent definition types for MusePi's /Agents system.
 *
 * An agent is a reusable subagent configuration backed by a system prompt
 * template (Markdown + YAML frontmatter). Agents are discovered from
 * multiple sources and displayed in the /Agents dashboard.
 *
 * Compatible with the existing swarm `SubAgentType` (explore/plan/coder)
 * and future user-defined agents.
 */

/** Where an agent definition originates. */
export type AgentSource = "bundled" | "user" | "project" | "extension";

/** Tools an agent may use. `"*"` means all available tools. */
export type AgentTools = string[] | "*";

/**
 * An agent's thinking/effort level.
 * - `"low"`: cheap / fast model, minimal thinking
 * - `"medium"`: balanced
 * - `"high"`: capable model, deep thinking
 * - `"auto"`: let the system decide
 */
export type AgentThinkingLevel = "low" | "medium" | "high" | "auto";

/**
 * Full agent definition.
 *
 * Mirrors OMP's AgentDefinition and is parseable from Markdown + YAML
 * frontmatter (`*.md` files in `agents/` directories).
 *
 * This is purely the definition from source (bundled or file).
 * Runtime state (enabled/disabled, model overrides) is in the Registry.
 */
export interface AgentDefinition {
	/** Unique identifier (kebab-case). Matches the swarm SubAgentType for bundled agents. */
	name: string;

	/** Human-readable one-line description. */
	description: string;

	/** Full system prompt template. */
	systemPrompt: string;

	/** Allowed tools or "*" for all. */
	tools: AgentTools;

	/**
	 * Sub-agent types this agent may spawn.
	 * `"*"` means any; an array lists allowed types.
	 * Absent / undefined means the agent spawns no sub-agents.
	 */
	spawns?: string[] | "*";

	/**
	 * Ranked model preference list (e.g. ["anthropic/claude-sonnet-4-20250514", "openai/gpt-4o"]).
	 * The first available model in the list is used; falls back to session default if none match.
	 * Absent / undefined means use the session default model.
	 */
	model?: string[];

	/** Thinking / effort level hint. */
	thinkingLevel?: AgentThinkingLevel;

	/**
	 * Output handling:
	 * - `"text"` — plain text output (default)
	 * - `"full"` — full structured output
	 * - Omit / undefined for default.
	 */
	output?: "text" | "full";

	/** If true, the agent blocks until its sub-agents complete. */
	blocking?: boolean;

	/**
	 * Pre-walk the conversation before acting.
	 * - `true`: read the full conversation first
	 * - `false` / undefined: skip pre-walk
	 * - A string value: pre-walk using the specified model
	 */
	prewalk?: boolean | string;

	/** Skills to auto-load when this agent runs. */
	autoloadSkills?: string[];

	/** Source of this agent definition. */
	source: AgentSource;

	/** Filesystem path to the definition file (empty for bundled). */
	filePath?: string;
}

/**
 * Minimal input for creating/registering agents from bundled code
 * (not filesystem). Same shape as AgentDefinition but all fields
 * except `name`/`description`/`systemPrompt` are optional.
 */
export interface AgentSpec {
	name: string;
	description: string;
	systemPrompt: string;
	tools?: AgentTools;
	spawns?: string[] | "*";
	model?: string[];
	thinkingLevel?: AgentThinkingLevel;
	prewalk?: boolean | string;
	output?: "text" | "full";
	blocking?: boolean;
	autoloadSkills?: string[];
}
