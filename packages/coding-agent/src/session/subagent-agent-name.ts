/**
 * Which agent definition produced a subagent transcript.
 *
 * The name lives in `session_init.agent`, and that record also carries the
 * full system prompt — in production it is routinely >100 KB with `agent` as
 * its last field, so no list-scan prefix window can reach it. Session listing
 * must not read whole transcripts, so this does one bounded read per file and
 * caches by path: a transcript's agent definition is fixed when it is spawned,
 * even though the file keeps growing.
 */

import * as fs from "node:fs";

/** Enough for a large system prompt plus the trailing fields; the record is
 *  written once, before any conversation, so it is always near the start. */
const MAX_BYTES = 1024 * 1024;

/** Path-keyed on purpose: appends keep changing mtime while the answer does
 *  not. A `null` is cached with the size that produced it, so a child whose
 *  `session_init` had not been flushed yet is retried once it grows. */
const names = new Map<string, { name: string | null; size: number }>();

/** Extract `agent` from a possibly truncated `session_init` record. */
function agentOfSessionInit(line: string): string | null {
	try {
		const record = JSON.parse(line) as { type?: unknown; agent?: unknown };
		if (record.type === "session_init" && typeof record.agent === "string" && record.agent) return record.agent;
		if (record.type === "session_init") return null;
	} catch {
		// Truncated at the read window: fall through to the field scan.
	}
	if (!line.startsWith('{"type":"session_init"')) return null;
	// The field is written last, after the prompt, so the LAST match on the
	// record is the real one — prompt text may mention the word too.
	const matches = [...line.matchAll(/"agent":"((?:[^"\\]|\\.)*)"/g)];
	const last = matches.at(-1)?.[1];
	return last ? last : null;
}

/** Agent definition name for one subagent transcript, or null. */
export async function readSubagentAgentName(file: string): Promise<string | null> {
	const cached = names.get(file);
	if (cached) {
		if (cached.name !== null) return cached.name;
		const stat = await fs.promises.stat(file).catch(() => null);
		if (!stat || stat.size === cached.size) return null;
	}
	let name: string | null = null;
	let size = 0;
	const handle = await fs.promises.open(file, "r").catch(() => null);
	if (handle) {
		try {
			const stat = await handle.stat();
			size = stat.size;
			const want = Math.min(stat.size, MAX_BYTES);
			const buffer = Buffer.allocUnsafe(want);
			const { bytesRead } = await handle.read(buffer, 0, want, 0);
			for (const line of buffer.subarray(0, bytesRead).toString("utf-8").split("\n")) {
				if (!line.startsWith('{"type":"session_init"')) continue;
				name = agentOfSessionInit(line);
				break;
			}
		} catch {
			// Unreadable transcript: no name is better than a wrong one.
		} finally {
			await handle.close();
		}
	}
	names.set(file, { name, size });
	return name;
}

/** Test seam: drop what this process has cached. */
export function resetSubagentAgentNameCache(): void {
	names.clear();
}
