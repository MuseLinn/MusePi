// ============================================================
// MusePi transcript — idempotent ops (L2).
//
// applyEntry maps one SessionEntry into the transcript. Applying the
// same entry twice yields the same transcript (replace, never
// duplicate), so stores can replay/rebuild from any point without
// bookkeeping. Turn rule: a user message opens a new turn; every
// following entry joins the open turn until the next user message.
// ============================================================

import {
	emptyTranscript,
	type Transcript,
	type TranscriptInteraction,
	type TranscriptTurn,
} from "./model.ts";

interface EntryLike {
	type: string;
	id: string;
	parentId?: string | null;
	timestamp: string;
	message?: {
		role: string;
		content?: string | Array<unknown>;
		stopReason?: string;
	};
	customType?: string;
	display?: boolean;
}

function textOf(content: string | Array<unknown> | undefined, type: string): string {
	if (!content) return "";
	if (typeof content === "string") return type === "text" ? content.trim() : "";
	return content
		.map((c) => c as Record<string, unknown> | null | undefined)
		.filter((c) => c?.type === type)
		.map((c) => String(c?.text ?? c?.thinking ?? ""))
		.join("\n")
		.trim();
}

/** Map one entry to zero or more interactions (thinking gets its own). */
function interactionsFor(entry: EntryLike): TranscriptInteraction[] {
	const base = { entryId: entry.id, timestamp: entry.timestamp };
	switch (entry.type) {
		case "message": {
			const msg = entry.message;
			if (!msg) return [];
			if (msg.role === "user") {
				return [{ ...base, kind: "user", text: textOf(msg.content, "text") }];
			}
			if (msg.role === "assistant") {
				const out: TranscriptInteraction[] = [];
				const text = textOf(msg.content, "text");
				const thinking = textOf(msg.content, "thinking");
				if (thinking) out.push({ ...base, kind: "thinking", thinking });
				if (text) out.push({ ...base, kind: "assistant", text });
				for (const raw of msg.content ?? []) {
					const c = raw as Record<string, unknown>;
					if (c?.type === "toolCall" || c?.type === "tool_call") {
						out.push({
							...base,
							kind: "tool_call",
							toolName: String(c.name ?? c.toolName ?? ""),
							toolCallId: String(c.id ?? c.toolCallId ?? ""),
						});
					}
				}
				return out;
			}
			if (msg.role === "toolResult") {
				const c = ((msg.content?.[0] ?? {}) as unknown) as Record<string, unknown>;
				return [{
					...base,
					kind: "tool_result",
					toolName: String((msg as unknown as Record<string, unknown>).toolName ?? c.toolName ?? ""),
					toolCallId: String((msg as unknown as Record<string, unknown>).toolCallId ?? c.toolCallId ?? ""),
					isError: Boolean((msg as unknown as Record<string, unknown>).isError),
					text: textOf(msg.content, "text").slice(0, 200),
				}];
			}
			return [];
		}
		case "custom_message":
			return [{
				...base,
				kind: "custom",
				display: entry.display !== false,
				text: typeof (entry as unknown as Record<string, unknown>).content === "string"
					? String((entry as unknown as Record<string, unknown>).content)
					: "",
				metaType: entry.customType,
			}];
		case "compaction":
		case "branch_summary":
		case "model_change":
		case "thinking_level_change":
		case "label":
		case "session_info":
			return [{ ...base, kind: "meta", metaType: entry.type }];
		default:
			return []; // custom state entries (CustomEntry) never join the transcript
	}
}

function openTurn(t: Transcript, interaction: TranscriptInteraction): TranscriptTurn {
	const turn: TranscriptTurn = {
		id: interaction.entryId,
		startedAt: interaction.timestamp,
		interactions: [],
		toolCalls: 0,
		hasError: false,
	};
	t.turns.push(turn);
	return turn;
}

function pushGroup(t: Transcript, interactions: TranscriptInteraction[]): void {
	if (interactions.length === 0) return;
	const entryId = interactions[0].entryId;
	const existing = t.byEntryId.get(entryId);
	if (existing) {
		// Idempotent: the same entry re-applied replaces its whole
		// interaction group in place (deterministic — same content).
		const turn = t.turns[existing.turn];
		if (turn) {
			turn.interactions.splice(existing.interaction, existing.count, ...interactions);
			// Positions after the splice shift when counts differ; the map is
			// only consulted for idempotent replacement of this entry, so
			// refreshing this entry's record is enough.
			existing.count = interactions.length;
		}
		return;
	}
	let turn = t.turns[t.turns.length - 1];
	if (interactions[0].kind === "user" || !turn) {
		turn = openTurn(t, interactions[0]);
	}
	t.byEntryId.set(entryId, {
		turn: t.turns.length - 1,
		interaction: turn.interactions.length,
		count: interactions.length,
	});
	turn.interactions.push(...interactions);
}

/** Apply one entry (idempotent). */
export function applyEntry(t: Transcript, entry: EntryLike): Transcript {
	pushGroup(t, interactionsFor(entry));
	return t;
}

/** Replay a full entry list into a fresh transcript. */
export function replayEntries(entries: readonly EntryLike[]): Transcript {
	const t = emptyTranscript();
	for (const e of entries) applyEntry(t, e);
	return t;
}
