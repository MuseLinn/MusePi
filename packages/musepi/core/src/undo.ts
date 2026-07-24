// ============================================================
// /undo — user-anchor rewind planning (pure, host-agnostic).
//
// kimi-code port (apps/kimi-code/src/tui/commands/undo.ts), adapted to
// pi's append-only session tree: instead of truncating history we compute
// a *navigation plan* — the anchor to `navigateTree(anchorId, { position:
// "before" })` on — so the undone turns stay on the old branch and nothing
// is deleted.
//
// Anchors are user-driven entries: user prompt messages and user-triggered
// bash executions (`!` / `!!`). Navigating "before" the anchor moves the
// leaf to the anchor's parent (or to the root when the anchor is the first
// branch entry), so resubmitting the refilled prompt forms a new branch at
// exactly the point the anchor originally hung from. The plan is capped at
// the most recent compaction entry: turns folded into a compaction summary
// cannot be unwound.
// ============================================================

export type UndoEntryKind = "user" | "bash" | "compaction" | "other";

/** Minimal host-neutral view of one session branch entry (root → leaf order). */
export interface UndoEntry {
	readonly id: string;
	readonly kind: UndoEntryKind;
	/** Full prompt text for kind "user". */
	readonly text?: string;
	/** Shell command for kind "bash" (without the leading `!`). */
	readonly command?: string;
	/** True for `!!` bash executions (excluded from LLM context). */
	readonly excludeFromContext?: boolean;
}

export interface UndoAnchor {
	/** Entry id of the anchor; the host navigates to "before" this entry. */
	readonly entryId: string;
	/** Text to refill into the editor (prompt text, or `!`/`!!` + command). */
	readonly refillText: string;
	/** Single-line preview for status/selector display. */
	readonly label: string;
}

export interface UndoAvailability {
	/** How many anchors can currently be undone. */
	readonly maxCount: number;
	/** True when a compaction entry bounds the active region. */
	readonly stoppedAtCompaction: boolean;
}

export type UndoPlan =
	| { readonly ok: true; readonly anchor: UndoAnchor; readonly availability: UndoAvailability }
	| { readonly ok: false; readonly reason: "nothing" | "limit"; readonly availability: UndoAvailability };

function isAnchorEntry(entry: UndoEntry): boolean {
	return entry.kind === "user" || entry.kind === "bash";
}

function singleLine(text: string): string {
	return text.replaceAll(/\s+/g, " ").trim();
}

/** Refill text for an anchor: the prompt as-is, or the bash command with its `!`/`!!` prefix. */
export function undoRefillText(entry: UndoEntry): string {
	if (entry.kind === "bash") {
		const prefix = entry.excludeFromContext ? "!!" : "!";
		return `${prefix}${entry.command ?? ""}`;
	}
	return entry.text ?? "";
}

/** Display label for an anchor (single line). */
export function undoAnchorLabel(entry: UndoEntry): string {
	if (entry.kind === "bash") {
		const prefix = entry.excludeFromContext ? "!!" : "!";
		return singleLine(`${prefix}${entry.command ?? ""}`) || "!";
	}
	const line = singleLine(entry.text ?? "");
	return line.length > 0 ? line : "User message";
}

/**
 * Resolve undo availability over a branch (root → leaf). Only entries after
 * the most recent compaction count.
 */
export function resolveUndoAvailability(entries: readonly UndoEntry[]): UndoAvailability {
	const lastCompactionIndex = findLastIndex(entries, (entry) => entry.kind === "compaction");
	const stoppedAtCompaction = lastCompactionIndex >= 0;
	const activeStart = stoppedAtCompaction ? lastCompactionIndex + 1 : 0;

	let maxCount = 0;
	for (let i = activeStart; i < entries.length; i++) {
		const entry = entries[i];
		if (entry !== undefined && isAnchorEntry(entry)) maxCount++;
	}
	return { maxCount, stoppedAtCompaction };
}

/**
 * Compute a rewind plan for `count` (1 = latest anchor). The returned anchor
 * identifies the entry to navigate "before", plus the refill text for the
 * prompt being rewound to.
 */
export function computeUndoPlan(entries: readonly UndoEntry[], count: number): UndoPlan {
	const availability = resolveUndoAvailability(entries);
	if (availability.maxCount === 0) {
		return { ok: false, reason: "nothing", availability };
	}
	if (!Number.isSafeInteger(count) || count < 1 || count > availability.maxCount) {
		return { ok: false, reason: "limit", availability };
	}

	let found = 0;
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry === undefined || !isAnchorEntry(entry)) continue;
		found++;
		if (found !== count) continue;
		return {
			ok: true,
			anchor: {
				entryId: entry.id,
				refillText: undoRefillText(entry),
				label: undoAnchorLabel(entry),
			},
			availability,
		};
	}
	return { ok: false, reason: "limit", availability };
}

/**
 * List all currently undoable anchors in branch order (oldest → newest).
 * Drives the interactive /undo selector.
 */
export function listUndoAnchors(entries: readonly UndoEntry[]): { anchors: UndoAnchor[]; availability: UndoAvailability } {
	const availability = resolveUndoAvailability(entries);
	if (availability.maxCount === 0) return { anchors: [], availability };
	const lastCompactionIndex = findLastIndex(entries, (entry) => entry.kind === "compaction");
	const activeStart = lastCompactionIndex >= 0 ? lastCompactionIndex + 1 : 0;
	const anchors: UndoAnchor[] = [];
	for (let i = activeStart; i < entries.length; i++) {
		const entry = entries[i];
		if (entry === undefined || !isAnchorEntry(entry)) continue;
		anchors.push({ entryId: entry.id, refillText: undoRefillText(entry), label: undoAnchorLabel(entry) });
	}
	return { anchors, availability };
}

/** Format the user-facing limit message (kimi wording, adapted). */
export function formatUndoLimitMessage(requestedCount: number, availability: UndoAvailability): string {
	const reason = availability.stoppedAtCompaction ? " after the last compaction" : "";
	const max = `${availability.maxCount} ${availability.maxCount === 1 ? "prompt" : "prompts"}`;
	const requested = `${requestedCount} ${requestedCount === 1 ? "prompt" : "prompts"}`;
	return `Cannot undo ${requested}; only ${max} can be undone in the active context${reason}.`;
}

/** Format the user-facing "nothing to undo" message. */
export function formatNothingToUndoMessage(availability: UndoAvailability): string {
	return availability.stoppedAtCompaction ? "Nothing to undo after the last compaction." : "Nothing to undo.";
}

function findLastIndex<T>(items: readonly T[], predicate: (item: T) => boolean): number {
	for (let i = items.length - 1; i >= 0; i--) {
		const item = items[i];
		if (item !== undefined && predicate(item)) return i;
	}
	return -1;
}
