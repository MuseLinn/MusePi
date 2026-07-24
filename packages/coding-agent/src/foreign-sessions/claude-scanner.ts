import { readdirSync, readFileSync, type Stats, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SessionInfo } from "../core/session-manager.ts";

/**
 * Format of a JSONL line in a Claude Code session file.
 * Only the fields we care about are typed.
 */
interface ClaudeSessionEvent {
	type: string;
	uuid?: string;
	/** user messages carry this */
	message?: {
		role?: string;
		content?: string | unknown[];
	};
	/** timestamp from the source agent, ISO‑8601 */
	timestamp?: string;
	/** working directory for user messages */
	cwd?: string;
	/** auto‑generated or user‑set title */
	customTitle?: string;
	aiTitle?: string;
	summary?: string;
	/** session id (redundant with filename) */
	sessionId?: string;
}

const CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");

const PROJECTS_DIR = join(CLAUDE_CONFIG_DIR, "projects");

/**
 * Sanitize a cwd path the same way Claude Code does:
 * all non‑alphanumeric chars → `-`
 */
function sanitizeCwd(cwd: string): string {
	return cwd
		.split("")
		.map((ch) => (/[A-Za-z0-9]/.test(ch) ? ch : "-"))
		.join("");
}

/**
 * Scan a single `.jsonl` file and return metadata.
 * Reads only the head (first 64 KB) to find the cwd + first prompt,
 * and the tail (last 64 KB) for a title, without loading the entire file.
 */
function scanSessionFile(filePath: string): SessionInfo | null {
	let fileStat: Stats;
	try {
		fileStat = statSync(filePath);
	} catch {
		return null;
	}
	if (!fileStat.isFile()) return null;

	// Read the whole file (typically <1 MB for most sessions).
	let raw: string;
	try {
		raw = readFileSync(filePath, "utf-8");
	} catch {
		return null;
	}
	const lines = raw.split("\n").filter(Boolean);
	if (lines.length === 0) return null;

	// Parse first few lines to find cwd and first user prompt
	let cwd = "";
	let firstMessage = "";
	let created: Date | null = null;
	let messageCount = 0;
	let title: string | undefined;
	const tailBlock = lines.slice(Math.max(0, lines.length - 50));

	for (const line of lines.slice(0, 100)) {
		let ev: ClaudeSessionEvent;
		try {
			ev = JSON.parse(line) as ClaudeSessionEvent;
		} catch {
			continue;
		}

		if (ev.type === "user" && ev.cwd && !cwd) {
			cwd = ev.cwd;
		}

		// First real user message (non-attachment, non-command)
		if (ev.type === "user" && ev.message?.role === "user" && !firstMessage) {
			const content = ev.message.content;
			if (typeof content === "string" && content.trim()) {
				firstMessage = content.trim().slice(0, 200);
			}
		}

		if (!created && ev.timestamp) {
			const d = new Date(ev.timestamp);
			if (!Number.isNaN(d.getTime())) created = d;
		}
	}

	// Count messages
	for (const line of lines) {
		try {
			const ev = JSON.parse(line) as ClaudeSessionEvent;
			if (ev.type === "user" || ev.type === "assistant") {
				messageCount++;
			}
		} catch {
			// skip malformed lines
		}
	}

	// Extract title from tail (customTitle > aiTitle > summary)
	for (const line of tailBlock) {
		try {
			const ev = JSON.parse(line) as ClaudeSessionEvent;
			title ??= ev.customTitle ?? ev.aiTitle ?? ev.summary;
		} catch {
			// skip
		}
	}

	if (!cwd || !firstMessage) return null;

	const uuid =
		filePath
			.replace(/\.jsonl$/i, "")
			.split(/[/\\]/)
			.pop() ?? "";

	return {
		path: filePath,
		id: uuid,
		cwd,
		source: "claude" as const,
		name: title,
		created: created ?? fileStat.birthtime,
		modified: fileStat.mtime,
		messageCount,
		firstMessage,
		allMessagesText: "",
	};
}

/**
 * List all Claude Code sessions for a given working directory.
 * Returns them as `SessionInfo[]` sorted newest-first.
 */
export function listClaudeSessions(cwd: string): SessionInfo[] {
	const sanitized = sanitizeCwd(cwd);
	const projectDir = join(PROJECTS_DIR, sanitized);

	let entries: string[];
	try {
		entries = readdirSync(projectDir);
	} catch {
		return [];
	}

	const sessions: SessionInfo[] = [];

	for (const entry of entries) {
		if (!entry.endsWith(".jsonl")) continue;
		const fullPath = join(projectDir, entry);
		const info = scanSessionFile(fullPath);
		if (info) sessions.push(info);
	}

	sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
	return sessions;
}

/**
 * Scan ALL Claude Code projects for sessions.
 * Returns sessions matching the given cwd (or all if wildcard).
 */
export function listAllClaudeSessions(): SessionInfo[] {
	let projectDirs: string[];
	try {
		projectDirs = readdirSync(PROJECTS_DIR);
	} catch {
		return [];
	}

	const all: SessionInfo[] = [];
	for (const dir of projectDirs) {
		const projectPath = join(PROJECTS_DIR, dir);
		let entries: string[];
		try {
			entries = readdirSync(projectPath);
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (!entry.endsWith(".jsonl")) continue;
			const info = scanSessionFile(join(projectPath, entry));
			if (info) all.push(info);
		}
	}

	all.sort((a, b) => b.modified.getTime() - a.modified.getTime());
	return all;
}
