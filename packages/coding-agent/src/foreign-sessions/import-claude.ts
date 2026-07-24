import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CLAUDE_DIR = join(homedir(), ".claude");

export interface ClaudeMcpServer {
	name: string;
	transport: "stdio" | "http" | "sse";
	command?: string;
	args?: string[];
	url?: string;
}

export interface ClaudeSettings {
	mcpServers: ClaudeMcpServer[];
}

export interface ClaudeSkillFile {
	name: string;
	path: string;
}

export interface ClaudeImportPreview {
	settings: ClaudeSettings | null;
	skills: ClaudeSkillFile[];
}

function readJson(path: string): Record<string, unknown> | null {
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
	} catch {
		return null;
	}
}

function readClaudeSettings(path: string): ClaudeSettings | null {
	const raw = readJson(path);
	if (!raw) return null;

	const mcpServers: ClaudeMcpServer[] = [];

	// MCP servers from ~/.claude.json / settings.json format
	const mcpRaw = raw.mcpServers as Record<string, Record<string, unknown>> | undefined;
	if (mcpRaw) {
		for (const [name, cfg] of Object.entries(mcpRaw)) {
			if (typeof cfg === "object" && cfg && typeof cfg.type === "string") {
				mcpServers.push({
					name,
					transport: cfg.type as "stdio" | "http" | "sse",
					command: cfg.command as string | undefined,
					args: cfg.args as string[] | undefined,
					url: cfg.url as string | undefined,
				});
			}
		}
	}

	return mcpServers.length > 0 ? { mcpServers } : null;
}

/**
 * Scan Claude Code's configuration and return a preview of importable items.
 */
export function scanClaudeConfig(): ClaudeImportPreview {
	const settingsPaths = [
		join(CLAUDE_DIR, "settings.json"),
		join(CLAUDE_DIR, "settings.local.json"),
		join(homedir(), ".claude.json"),
	];

	let settings: ClaudeSettings | null = null;
	for (const p of settingsPaths) {
		const result = readClaudeSettings(p);
		if (result) {
			settings = {
				mcpServers: settings ? [...settings.mcpServers, ...result.mcpServers] : result.mcpServers,
			};
		}
	}

	const skills: ClaudeSkillFile[] = [];
	const skillsDir = join(CLAUDE_DIR, "skills");
	try {
		for (const entry of readdirSync(skillsDir)) {
			const fullPath = join(skillsDir, entry);
			if (entry.endsWith(".md") && statSync(fullPath).isFile()) {
				skills.push({ name: entry.replace(/\.md$/, ""), path: fullPath });
			}
		}
	} catch {
		// no skills directory
	}

	return { settings, skills };
}
