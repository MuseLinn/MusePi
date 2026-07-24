import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { FileEntry, SessionHeader, SessionMessageEntry } from "../core/session-manager.ts";

/**
 * Convert a Claude Code JSONL session file into a MusePi session file.
 * Returns the path to the converted session file.
 */
export function convertClaudeSession(claudeJsonlPath: string, targetDir: string): string {
	const raw = readFileSync(claudeJsonlPath, "utf-8");
	const lines = raw.split("\n").filter(Boolean);

	// Parse the first user message to get cwd and original session id
	let firstCwd = "";
	let originalSessionId = "";
	const entries: FileEntry[] = [];

	// First pass: collect metadata
	for (const line of lines) {
		try {
			const ev = JSON.parse(line);
			if (ev.type === "user" && ev.cwd && !firstCwd) {
				firstCwd = ev.cwd;
			}
			if (ev.sessionId && !originalSessionId) {
				originalSessionId = ev.sessionId;
			}
		} catch {
			// skip malformed
		}
	}

	const sessionId = originalSessionId || randomUUID();
	const now = new Date().toISOString();

	// Header
	const header: SessionHeader = {
		type: "session",
		version: 3,
		id: sessionId,
		timestamp: now,
		cwd: firstCwd,
	};
	entries.push(header);

	// Track IDs for parentId chain
	let prevId: string | null = null;
	const messageIds = new Set<string>();

	// Second pass: convert user/assistant events to message entries
	for (const line of lines) {
		let ev: Record<string, unknown>;
		try {
			ev = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue;
		}

		const type = ev.type as string;
		if (type !== "user" && type !== "assistant") continue;

		const msg = ev.message as { role?: string; content?: string | unknown[] } | undefined;
		if (!msg?.role) continue;

		const entryId = (ev.uuid as string) || randomUUID();
		if (messageIds.has(entryId)) continue; // deduplicate
		messageIds.add(entryId);

		// Pass Claude Code content natively instead of flattening to JSON.
		const message = {
			role: msg.role as "user" | "assistant",
			content: msg.content,
		} as unknown as AgentMessage;
		const entry: SessionMessageEntry = {
			type: "message",
			id: entryId,
			parentId: prevId,
			timestamp: (ev.timestamp as string) || now,
			message,
		};
		entries.push(entry);
		prevId = entryId;
	}

	// Write converted session file
	mkdirSync(targetDir, { recursive: true });
	const filename = `${now.replace(/[:.]/g, "-")}_${sessionId}.jsonl`;
	const outPath = join(targetDir, filename);
	const jsonl = `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`;
	writeFileSync(outPath, jsonl, "utf-8");

	return outPath;
}
