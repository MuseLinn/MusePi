/**
 * Parse agent definitions from Markdown + YAML frontmatter.
 *
 * Agent files are `.md` files with YAML frontmatter between `---` markers,
 * followed by the system prompt body. The frontmatter maps to AgentSpec
 * fields; the body becomes `systemPrompt`.
 *
 * File naming convention: `<agent-name>.md` — the filename (without .md)
 * is used as `name` when the frontmatter has no `name` field.
 */

import type { AgentDefinition, AgentSource } from "@musepi/core";

/** Regex matching the frontmatter block. */
const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)?$/;

export interface ParseAgentResult {
	/** Parsed name from frontmatter or filename. */
	name: string;
	/** Human-readable description. */
	description: string;
	/** System prompt body. */
	systemPrompt: string;
	/** Allowed tools or "*". */
	tools: AgentDefinition["tools"];
	/** Sub-agent spawns. */
	spawns: AgentDefinition["spawns"];
	/** Ranked model preference list. */
	model: string[] | undefined;
	/** Thinking level. */
	thinkingLevel: AgentDefinition["thinkingLevel"];
	/** Whether to pre-walk. */
	prewalk: AgentDefinition["prewalk"];
	/** Source annotation for the registry. */
	source: AgentSource;
}

/**
 * Parse a single agent definition from a Markdown string.
 * Returns null if the file is not valid agent markdown (no frontmatter).
 */
export function parseAgentMarkdown(content: string, fileName: string): ParseAgentResult | null {
	const match = FRONTMATTER_RE.exec(content);
	if (!match) return null;

	const raw = match[1];
	const body = (match[2] ?? "").trim();
	const fields = parseYamlBlock(raw);

	const name = (fields.name as string) ?? fileName.replace(/\.md$/i, "");
	if (!name) return null;

	return {
		name,
		description: (fields.description as string) ?? "",
		systemPrompt: body,
		tools: parseTools(fields.tools),
		spawns: parseSpawns(fields.spawns),
		model: parseModel(fields.model),
		thinkingLevel: parseThinkingLevel(fields["thinking-level"]),
		prewalk: parsePrewalk(fields.prewalk),
		source: "user", // caller overrides this
	};
}

/**
 * Simple YAML frontmatter parser.
 * Only handles flat key-value pairs and basic types (string, number, boolean, array).
 */
function parseYamlBlock(raw: string): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	const stripped = raw.replace(/^\s+|\s+$/g, "");

	// Try JSON first (some agents use JSON frontmatter)
	try {
		const parsed = JSON.parse(stripped) as Record<string, unknown>;
		if (parsed && typeof parsed === "object") return parsed;
	} catch {
		// Not JSON, continue with YAML parsing
	}

	for (const line of stripped.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;

		const colonIndex = trimmed.indexOf(":");
		if (colonIndex === -1) continue;

		const key = trimmed.slice(0, colonIndex).trim();
		let value: unknown = trimmed.slice(colonIndex + 1).trim();

		if (value === "" || value === "~" || value === "null") {
			value = undefined;
		} else if (value === "true") {
			value = true;
		} else if (value === "false") {
			value = false;
		} else if (value.startsWith("[") && value.endsWith("]")) {
			value = value
				.slice(1, -1)
				.split(",")
				.map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
				.filter(Boolean);
		} else if (/^\d+$/.test(value as string)) {
			value = Number(value);
		} else {
			// Remove surrounding quotes
			value = (value as string).replace(/^['"]|['"]$/g, "");
		}

		result[key] = value;
	}

	return result;
}

function parseTools(value: unknown): string[] | "*" | undefined {
	if (value === "*") return "*";
	if (Array.isArray(value)) return value.filter((t): t is string => typeof t === "string");
	if (typeof value === "string") {
		if (value === "*") return "*";
		return value
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
	}
	return undefined;
}

function parseSpawns(value: unknown): string[] | "*" | undefined {
	if (value === "*" || value === undefined) return value as "*" | undefined;
	if (Array.isArray(value)) return value.filter((s): s is string => typeof s === "string");
	if (typeof value === "string") {
		if (value === "*") return "*";
		return value
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
	}
	return undefined;
}

/**
 * Parse model field: can be a single string or string[] in the frontmatter.
 * Returns `string[]` or undefined.
 */
function parseModel(value: unknown): string[] | undefined {
	if (Array.isArray(value)) return value.filter((m): m is string => typeof m === "string");
	if (typeof value === "string" && value.length > 0) return [value];
	return undefined;
}

function parseThinkingLevel(value: unknown): AgentDefinition["thinkingLevel"] {
	if (value === "low" || value === "medium" || value === "high" || value === "auto") return value;
	return undefined;
}

function parsePrewalk(value: unknown): AgentDefinition["prewalk"] {
	if (typeof value === "boolean") return value;
	if (typeof value === "string" && value.length > 0) return value;
	return undefined;
}

/**
 * Format an AgentSpec or AgentDefinition back to Markdown.
 */
export function formatAgentMarkdown(
	name: string,
	spec: {
		description: string;
		systemPrompt: string;
		tools?: string[] | "*";
		model?: string[];
		prewalk?: boolean | string;
	},
): string {
	const fields: string[] = [`name: ${name}`, `description: "${spec.description}"`];

	if (spec.tools) {
		fields.push(`tools: ${Array.isArray(spec.tools) ? `[${spec.tools.join(", ")}]` : '"*"'}`);
	}
	if (spec.model && spec.model.length > 0) {
		const models = spec.model.map((m) => `"${m}"`).join(", ");
		fields.push(`model: [${models}]`);
	}
	if (spec.prewalk) {
		fields.push(`prewalk: ${typeof spec.prewalk === "string" ? `"${spec.prewalk}"` : "true"}`);
	}

	return `---\n${fields.join("\n")}\n---\n\n${spec.systemPrompt}`;
}
