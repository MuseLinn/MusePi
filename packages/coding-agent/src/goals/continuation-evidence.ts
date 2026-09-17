/**
 * Model-visible tool evidence fingerprints for Goal-mode continuations.
 *
 * Goal mode re-prompts the model with a hidden `Continue active goal` message
 * after every round. The original gate only asked "did the round call any
 * tool?" — so a read-only round that changed nothing (a `todo view` returning
 * the same snapshot, a `read` of an unchanged file) still counted as progress
 * and the harness kept waking the model every 800ms forever (oh-my-pi #11819,
 * fixed upstream in #11822).
 *
 * The fix is to fingerprint what the MODEL actually saw, not that a tool ran:
 * two consecutive continuations whose visible evidence is byte-identical carry
 * no new information, so the loop must idle instead of re-prompting. Any real
 * change — different args, different output, an error appearing or clearing —
 * produces a different fingerprint and still permits the next continuation.
 *
 * The fingerprint is deliberately content-based rather than identity-based
 * (tool-call ids differ every round and must not count as change) and is
 * capped, so a tool that returns a large blob every round cannot stall the
 * loop by making the digest unstable.
 */

/** Cap per tool result before hashing — the model's window, not the whole payload. */
const RESULT_SAMPLE_LIMIT = 2048;

export interface ToolEvidence {
	/** Tool name as the model sees it (e.g. "todo", "read"). */
	toolName: string;
	/** Tool arguments, already ser/deser-able (the raw event payload). */
	args: unknown;
	/** The tool's result payload. */
	result: unknown;
	/** Whether the call surfaced as an error to the model. */
	isError?: boolean;
}

/** Stable JSON: object keys sorted, so key order in a payload cannot fake a change. */
function stableStringify(value: unknown, seen = new WeakSet<object>()): string {
	if (value === null || value === undefined) return "null";
	const kind = typeof value;
	if (kind === "number") return Number.isFinite(value as number) ? String(value) : "null";
	if (kind === "boolean" || kind === "bigint") return String(value);
	if (kind === "string") return JSON.stringify(value);
	if (kind === "function" || kind === "symbol") return "null";
	if (kind !== "object") return JSON.stringify(String(value));

	if (seen.has(value as object)) return '"[circular]"';
	seen.add(value as object);

	if (Array.isArray(value)) {
		return `[${value.map(v => stableStringify(v, seen)).join(",")}]`;
	}
	const entries = Object.keys(value as Record<string, unknown>)
		.sort()
		.map(k => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k], seen)}`);
	return `{${entries.join(",")}}`;
}

/** Flatten a tool result to the text the model would read, when it is structured. */
function resultToText(result: unknown): string {
	if (result === null || result === undefined) return "";
	if (typeof result === "string") return result;
	// Common shapes: { content: [{ type: "text", text }] } or a bare object.
	const content = (result as { content?: unknown }).content;
	if (Array.isArray(content)) {
		const parts: string[] = [];
		for (const part of content) {
			if (typeof part === "string") parts.push(part);
			else if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
				parts.push((part as { text: string }).text);
			}
		}
		if (parts.length > 0) return parts.join("\n");
	}
	if (typeof content === "string") return content;
	return stableStringify(result);
}

/**
 * Fingerprint one round's model-visible tool evidence.
 *
 * Returns a stable string: same visible evidence ⇒ same fingerprint. An empty
 * round (no tools) returns the empty string, which callers treat as "no
 * evidence" — the pre-existing no-tool path.
 */
export function fingerprintToolEvidence(evidence: readonly ToolEvidence[]): string {
	if (evidence.length === 0) return "";
	const parts: string[] = [];
	for (const item of evidence) {
		const name = item.toolName ?? "unknown";
		const args = stableStringify(item.args);
		const result = resultToText(item.result);
		const sample = result.length > RESULT_SAMPLE_LIMIT ? result.slice(0, RESULT_SAMPLE_LIMIT) : result;
		const err = item.isError ? "!error" : "";
		parts.push(`${name}${err}\u0000${args}\u0000${sample.length}\u0000${sample}`);
	}
	// A cheap, dependency-free digest (FNV-1a 32-bit, hex) — stable across runs
	// and platforms, unlike anything seeded or time-based.
	const joined = parts.join("\u0001");
	let hash = 0x811c9dc5;
	for (let i = 0; i < joined.length; i++) {
		hash ^= joined.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return `${evidence.length}:${hash.toString(16).padStart(8, "0")}`;
}

/**
 * Decide whether a continuation should be suppressed because the round added no
 * new model-visible evidence.
 *
 * - A round with no tool calls never permits a continuation (unchanged from the
 *   original `#goalTurnHadToolCalls` gate).
 * - A round with tools whose evidence fingerprints identically to the previous
 *   round is idle-inducing too: the model saw nothing new.
 * - Any change in the fingerprint permits the next continuation.
 */
export function shouldSuppressContinuation(currentFingerprint: string, previousFingerprint: string | null): boolean {
	if (currentFingerprint === "") return true;
	return previousFingerprint !== null && currentFingerprint === previousFingerprint;
}
