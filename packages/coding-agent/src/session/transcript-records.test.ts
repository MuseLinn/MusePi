import { describe, expect, it } from "bun:test";
import type { CustomMessageEntry, FileEntry, SessionMessageEntry } from "./session-entries";
import {
	customMessageEntryToSessionMessage,
	extractRenderableEntries,
	HIDDEN_BY_DEFAULT_ENTRY_TYPES,
	isHiddenByDefaultEntry,
} from "./transcript-records";

/**
 * Transcript record-family preservation.
 *
 * The hub transcript viewer used to select conversation entries with
 * `entry.type === "message"`, which dropped every `custom_message` — advisor
 * cards, hook notices, collab and skill prompts — with no placeholder and no
 * error. The live transcript renders the same entries, so the two surfaces
 * disagreed about the same file. A subagent session run with
 * `advisor: true` keeps its advisor cards in its OWN jsonl, which made the
 * viewer drop exactly the rows identifying what it was showing.
 */

/** Real advisor entry shape (session 01a04111, journal line 36). */
const advisorEntry = (over: Partial<CustomMessageEntry> = {}): CustomMessageEntry => ({
	type: "custom_message",
	id: "adv1",
	parentId: "a1",
	timestamp: "2026-09-28T04:43:01.517Z",
	customType: "advisor",
	content: '<advisory severity="concern" guidance="weigh">先用 round()</advisory>',
	details: {
		notes: [{ note: "ms→points 往返要 round()", severity: "concern" }],
	},
	display: true,
	attribution: "agent",
	...over,
});

const userEntry = (id: string): SessionMessageEntry => ({
	type: "message",
	id,
	parentId: null,
	timestamp: "2026-09-28T04:43:00.000Z",
	message: {
		role: "user",
		content: "优化时间范围选择",
		timestamp: 1759012980000,
	},
});

const assistantEntry = (id: string): SessionMessageEntry => ({
	type: "message",
	id,
	parentId: "u1",
	timestamp: "2026-09-28T04:43:01.000Z",
	message: {
		role: "assistant",
		content: [{ type: "text", text: "好的" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test-model",
		usage: {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1759012981000,
	},
});

describe("extractRenderableEntries", () => {
	it("keeps advisor cards — the record family a message-only gate dropped", () => {
		const entries: FileEntry[] = [userEntry("u1"), advisorEntry(), assistantEntry("a1")];
		const out = extractRenderableEntries(entries);
		expect(out).toHaveLength(3);
		expect(out.map(e => e.id)).toEqual(["u1", "adv1", "a1"]);
		const advisor = out[1]!;
		expect(advisor.message.role).toBe("custom");
		if (advisor.message.role !== "custom") throw new Error("unreachable");
		// The advisor card is built from `details`; `content` is the model-facing
		// XML and must survive the hop without ever being what gets rendered.
		expect(advisor.message.details).toEqual({
			notes: [{ note: "ms→points 往返要 round()", severity: "concern" }],
		});
		expect(advisor.message.customType).toBe("advisor");
		expect(advisor.message.display).toBe(true);
		expect(advisor.message.attribution).toBe("agent");
	});

	it("preserves entry identity and file order across the conversion", () => {
		const out = extractRenderableEntries([userEntry("u1"), advisorEntry(), assistantEntry("a1")]);
		const advisor = out[1]!;
		expect(advisor.type).toBe("message");
		expect(advisor.id).toBe("adv1");
		expect(advisor.parentId).toBe("a1");
		expect(advisor.timestamp).toBe("2026-09-28T04:43:01.517Z");
		if (advisor.message.role !== "custom") throw new Error("unreachable");
		// The in-memory message type wants epoch ms; the entry carries ISO.
		expect(advisor.message.timestamp).toBe(Date.parse("2026-09-28T04:43:01.517Z"));
	});

	it("skips bookkeeping entries without disturbing the rest", () => {
		const entries: FileEntry[] = [
			userEntry("u1"),
			{
				type: "model_change",
				id: "m1",
				parentId: null,
				timestamp: "2026-09-28T04:43:00.500Z",
				model: "sonnet",
			},
			{
				type: "label",
				id: "l1",
				parentId: null,
				timestamp: "2026-09-28T04:43:00.600Z",
				targetId: "u1",
				label: "x",
			},
			advisorEntry(),
			{
				type: "thinking_level_change",
				id: "t1",
				parentId: null,
				timestamp: "2026-09-28T04:43:00.700Z",
				thinkingLevel: "high",
			},
			assistantEntry("a1"),
		];
		expect(extractRenderableEntries(entries).map(e => e.id)).toEqual(["u1", "adv1", "a1"]);
	});

	it("leaves visibility to the renderer, so a hidden note is still selected", () => {
		// The builder drops `display: false` cards itself
		// (chat-transcript-builder `#appendCustomMessage`). Filtering here would
		// duplicate that rule in a second place and diverge from it.
		const out = extractRenderableEntries([advisorEntry({ display: false })]);
		expect(out).toHaveLength(1);
		if (out[0]!.message.role !== "custom") throw new Error("unreachable");
		expect(out[0]!.message.display).toBe(false);
	});
});

describe("hidden-by-default entry types", () => {
	it("excludes exactly the bookkeeping types /tree hid, no more and no fewer", () => {
		// Pinning the set matters because the list existed twice — a function-local
		// const in tree-selector and a separate copy in export/html/template.js
		// already missing four of these. Sharing one list is the fix; drifting it
		// again re-creates the split.
		expect([...HIDDEN_BY_DEFAULT_ENTRY_TYPES].sort()).toEqual([
			"credential_pin",
			"custom",
			"label",
			"mode_change",
			"model_change",
			"reset_boundary",
			"service_tier_change",
			"session_init",
			"thinking_level_change",
			"title_change",
			"ttsr_injection",
		]);
	});

	it("never treats custom_message as hidden — that is the bug this guards", () => {
		expect(isHiddenByDefaultEntry({ type: "custom_message" })).toBe(false);
		expect(isHiddenByDefaultEntry({ type: "message" })).toBe(false);
		// A hidden ADVISOR note is still a custom_message: visibility is the
		// renderer's call, so it must not be excluded by type either.
		expect(isHiddenByDefaultEntry({ type: "custom_message" })).toBe(false);
	});
});

describe("customMessageEntryToSessionMessage", () => {
	it("round-trips the payload #persistMessageEnd writes", () => {
		// #persistMessageEnd persists (customType, content, display, details,
		// attribution); the hop back must not drop or rename any of them.
		const entry = advisorEntry();
		const msg = customMessageEntryToSessionMessage(entry);
		if (msg.message.role !== "custom") throw new Error("unreachable");
		expect(msg.message.customType).toBe(entry.customType);
		expect(msg.message.content).toBe(entry.content);
		expect(msg.message.display).toBe(entry.display);
		expect(msg.message.details).toBe(entry.details);
		expect(msg.message.attribution).toBe(entry.attribution);
	});

	it("falls back to a usable numeric timestamp for an unparseable stamp", () => {
		// A corrupt line must still render rather than produce NaN downstream.
		const msg = customMessageEntryToSessionMessage(advisorEntry({ timestamp: "not-a-date" }));
		if (msg.message.role !== "custom") throw new Error("unreachable");
		expect(Number.isFinite(msg.message.timestamp)).toBe(true);
	});
});
