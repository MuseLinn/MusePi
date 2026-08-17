import { describe, expect, it } from "bun:test";
import type { AssistantMessage, SessionEntry } from "@musepi/pi-wire";
import { renderToStaticMarkup } from "react-dom/server";
import "./transcript-dom-shim";
import { msgText, Transcript } from "../src/components/transcript/Transcript";
import type { ActiveTool } from "../src/lib/client";

const TOOL_CALL_ID = "call-running-tool";
const TOOL_NAME = "probe_tool";

const RAW_ASSISTANT_TARGET = "stale-raw-assistant-target";
const ACTIVE_TOOL_TARGET = "effective-active-tool-target";

function assistantUsage(): AssistantMessage["usage"] {
	return { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { total: 0 } };
}

function committedAssistantToolCall(): SessionEntry {
	return {
		type: "message",
		id: "assistant-entry-1",
		parentId: null,
		timestamp: "2026-07-09T00:00:00Z",
		message: {
			role: "assistant",
			content: [
				{ type: "text", text: "I will run the tool." },
				{
					type: "toolCall",
					id: TOOL_CALL_ID,
					name: TOOL_NAME,
					arguments: { target: RAW_ASSISTANT_TARGET },
					intent: "Inspect fixture input",
				},
			],
			model: "test/model",
			usage: assistantUsage(),
			stopReason: "stop",
			timestamp: 1,
		},
	};
}

function activeTool(): ActiveTool {
	return {
		toolCallId: TOOL_CALL_ID,
		toolName: TOOL_NAME,
		args: { target: ACTIVE_TOOL_TARGET },
		intent: "Inspect fixture input",
		startedAt: 1,
	};
}

function assistantEntry(overrides: { timestamp: number; duration?: number; text?: string }): SessionEntry {
	return {
		type: "message",
		id: `assistant-${overrides.timestamp}`,
		parentId: null,
		timestamp: "2026-07-09T00:00:00Z",
		message: {
			role: "assistant",
			content: [{ type: "text", text: overrides.text ?? "hello" }],
			model: "test/model",
			usage: assistantUsage(),
			stopReason: "stop",
			timestamp: overrides.timestamp,
			...(overrides.duration !== undefined ? { duration: overrides.duration } : {}),
		},
	};
}

function userEntry(timestamp: number): SessionEntry {
	return {
		type: "message",
		id: `user-${timestamp}`,
		parentId: null,
		timestamp: "2026-07-09T00:00:00Z",
		message: { role: "user", content: "do it", timestamp },
	};
}

function renderTranscript(props: {
	entries?: readonly SessionEntry[];
	activeTools?: ReadonlyMap<string, ActiveTool>;
	working: boolean;
	roundDurations?: ReadonlyMap<number, number>;
	hideToolActivity?: boolean;
	showTokenUsage?: boolean;
	collapseCompacted?: boolean;
	colorBlind?: boolean;
}): string {
	return renderToStaticMarkup(
		<Transcript
			entries={props.entries ?? []}
			stream={null}
			streamDone={true}
			activeTools={props.activeTools ?? new Map()}
			working={props.working}
			roundDurations={props.roundDurations}
			hideToolActivity={props.hideToolActivity}
			showTokenUsage={props.showTokenUsage}
			collapseCompacted={props.collapseCompacted}
			colorBlind={props.colorBlind}
		/>,
	);
}

function countElements(html: string, selector: string): number {
	let count = 0;
	new HTMLRewriter()
		.on(selector, {
			element() {
				count++;
			},
		})
		.transform(html);
	return count;
}

function countOccurrences(text: string, needle: string): number {
	let count = 0;
	let start = 0;
	while (true) {
		const index = text.indexOf(needle, start);
		if (index === -1) return count;
		count++;
		start = index + needle.length;
	}
}

describe("Transcript live tool rendering", () => {
	it("renders one running card for a committed tool call using active args without the working shimmer", () => {
		const html = renderTranscript({
			entries: [committedAssistantToolCall()],
			activeTools: new Map([[TOOL_CALL_ID, activeTool()]]),
			working: true,
		});

				expect(countOccurrences(html, 'class="tv-card"')).toBe(1);
		expect(countOccurrences(html, 'aria-label="Running"')).toBe(1);
		expect(countOccurrences(html, TOOL_NAME)).toBe(1);
		expect(html).not.toContain("thinking…");
		expect(html).toContain(ACTIVE_TOOL_TARGET);
		expect(html).not.toContain(RAW_ASSISTANT_TARGET);
	});

	it("keeps the working state quiet in the transcript when no tool is active", () => {
		// musepi: the pre-stream thinking state is carried by the Composer
		// status bar (orb + text); a transcript shimmer row with its own orb
		// duplicated it (user-requested). The transcript must neither show the
		// idle empty state nor a fake shimmer while working.
		const html = renderTranscript({ working: true, activeTools: new Map() });

		expect(html).not.toContain("thinking…");
		expect(html).not.toContain("no activity yet");
	});
});

describe("work timer (已工作 X 秒, per-round)", () => {
	// 5.5s in the past: elapsed >= 5500ms at SSR → rounds to 6 deterministically
	// (the anchor is the LAST USER message timestamp — the round start — NOT
	// the component mount time, craft-agents ProcessingIndicator parity).
	const USER_TS = Date.now() - 5_500;
	const ASSISTANT_TS = USER_TS + 100;
	const ticking = /working for 6s|已工作 6 秒/;
	const took = /took 6s|用时 6 秒/;
	const round = (ms: number): ReadonlyMap<number, number> => new Map([[ASSISTANT_TS, ms]]);

	it("ticks from the round start (last user message) while working", () => {
		const html = renderTranscript({
			entries: [userEntry(USER_TS), assistantEntry({ timestamp: ASSISTANT_TS })],
			working: true,
		});
		expect(countElements(html, ".tr-working")).toBe(1);
		expect(countElements(html, ".tr-working-spin")).toBe(1);
		expect(html).toMatch(ticking);
	});

	it("stays anchored across remounts (switching sessions and back)", () => {
		const entries = [userEntry(USER_TS), assistantEntry({ timestamp: ASSISTANT_TS })];
		// Two independent mounts of the same data must report the SAME total —
		// a mount-anchored timer (the pre-fix bug) restarts at 0 here.
		const a = renderTranscript({ entries, working: true });
		const b = renderTranscript({ entries, working: true });
		expect(a).toMatch(ticking);
		expect(b).toMatch(ticking);
	});

	it("shows the frozen round total on the completed round's final message (no spinner)", () => {
		const html = renderTranscript({
			entries: [userEntry(USER_TS), assistantEntry({ timestamp: ASSISTANT_TS })],
			working: false,
			roundDurations: round(6_300),
		});
		expect(countElements(html, ".tr-working")).toBe(1);
		expect(countElements(html, ".tr-working-spin")).toBe(0);
		expect(html).toMatch(took);
	});

	it("keeps EVERY completed round's total visible (每轮单独计时)", () => {
		const a1 = USER_TS - 60_000;
		const a2 = USER_TS - 30_000;
		const entries = [
			userEntry(a1 - 100),
			assistantEntry({ timestamp: a1 }),
			userEntry(a2 - 100),
			assistantEntry({ timestamp: a2 }),
			userEntry(USER_TS),
			assistantEntry({ timestamp: ASSISTANT_TS }),
		];
		const html = renderTranscript({
			entries,
			working: false,
			roundDurations: new Map([
				[a1, 6_300],
				[a2, 12_700],
				[ASSISTANT_TS, 1_900],
			]),
		});
		expect(countElements(html, ".tr-working")).toBe(3);
		expect(countElements(html, ".tr-working-spin")).toBe(0);
	});

	it("shows no frozen total without a recorded round duration (history replay)", () => {
		const html = renderTranscript({
			entries: [userEntry(USER_TS), assistantEntry({ timestamp: ASSISTANT_TS })],
			working: false,
		});
		expect(countElements(html, ".tr-working")).toBe(0);
	});

	it("ghost stream row shows the frozen total once streamDone", () => {
		const stream: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "done" }],
			model: "test/model",
			usage: assistantUsage(),
			stopReason: "stop",
			timestamp: ASSISTANT_TS,
		};
		const html = renderToStaticMarkup(
			<Transcript
				entries={[]}
				stream={stream}
				streamDone={true}
				activeTools={new Map()}
				working={false}
				roundDurations={round(6_300)}
			/>,
		);
		expect(countElements(html, ".tr-working")).toBe(1);
		expect(countElements(html, ".tr-working-spin")).toBe(0);
		expect(html).toMatch(took);
	});
});

describe("Transcript message Markdown", () => {
	it("renders host strings and guest text blocks as Markdown", () => {
		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "host-markdown",
				parentId: null,
				timestamp: "2026-07-15T00:00:00Z",
				message: {
					role: "user",
					content: "Use `381866285601915778`",
					timestamp: 1,
				},
			},
			{
				type: "custom_message",
				id: "guest-markdown",
				parentId: "host-markdown",
				timestamp: "2026-07-15T00:00:01Z",
				customType: "collab-prompt",
				content: [{ type: "text", text: "Guest uses **Markdown**" }],
				details: { from: "guest" },
				display: true,
			},
		];

		const html = renderTranscript({ entries, working: false });

		expect(countElements(html, ".tr-row--user .tr-md code")).toBe(1);
		expect(countElements(html, ".tr-row--user .tr-md strong")).toBe(1);
	});
});

describe("TTSR / IRC custom_message rendering", () => {
	function ttsrEntry(): SessionEntry {
		return {
			type: "custom_message",
			id: "ttsr-1",
			parentId: null,
			timestamp: "2026-08-09T00:00:00Z",
			customType: "ttsr",
			content: "no-console、fence",
			display: true,
			details: {
				rules: [
					{ name: "no-console", description: "不许直接 console.log" },
					{ name: "fence", content: "代码栅栏" },
				],
			},
		};
	}

	it("renders a ttsr entry as a warning block with rule names", () => {
		const html = renderTranscript({ entries: [ttsrEntry()], working: false });
		expect(html).toContain("tr-ttsr");
		expect(html).toContain("no-console");
		expect(html).toContain("fence");
		// description visible in the (collapsed-body still mounted) markup
		expect(html).toContain("不许直接 console.log");
	});

	it("renders irc: entries as custom rows with the sender badge", () => {
		const entry: SessionEntry = {
			type: "custom_message",
			id: "irc-1",
			parentId: null,
			timestamp: "2026-08-09T00:00:01Z",
			customType: "irc:incoming",
			content: "sub: 我查一下 git 历史",
			display: true,
			details: { id: "m1", from: "sub", message: "我查一下 git 历史" },
		};
		const html = renderTranscript({ entries: [entry], working: false });
		expect(html).toContain("tr-irc");
		expect(html).toContain("sub");
		expect(html).toContain("我查一下 git 历史");
	});

	it("renders the long sender name in the body label, not the clipped gutter", () => {
		// Agent ids like "SurveyOpenchamber" overflow the 40px gutter badge;
		// the sender must render as a full-width label inside the body.
		const entry: SessionEntry = {
			type: "custom_message",
			id: "irc-4",
			parentId: null,
			timestamp: "2026-08-09T00:00:04Z",
			customType: "irc:incoming",
			content: "ignored",
			display: true,
			details: { id: "m4", from: "SurveyOpenchamber", message: "Where is the repo?" },
		};
		const html = renderTranscript({ entries: [entry], working: false });
		expect(html).toContain("tr-irc-from");
		// The name sits inside the body (full row width), not the 40px gutter.
		expect(html).toMatch(/tr-irc-from">SurveyOpenchamber</);
		// The gutter div stays empty (no badge clipping long agent ids).
		expect(html).toMatch(/tr-gutter[^>]*><\/div>/);
		expect(html).toContain("Where is the repo?");
	});

	it("strips the LLM prompt wrapper from irc:incoming content", () => {
		// The daemon persists the rendered irc-incoming.md template (literal
		// <irc>…</irc> scaffolding + reply instructions) as content; the clean
		// body lives in details.message. The row must render the body, not the
		// prompt wrapper.
		const entry: SessionEntry = {
			type: "custom_message",
			id: "irc-2",
			parentId: null,
			timestamp: "2026-08-09T00:00:02Z",
			customType: "irc:incoming",
			content:
				"<irc>\nIncoming IRC message from agent `scoutA`:\n\nWhere is the repo?\n\nIf response expected, reply via `hub` (`op: \"send\"`, `to: \"scoutA\"`); may finish current step first. No one replies on your behalf.\n</irc>",
			display: true,
			details: { id: "m2", from: "scoutA", message: "Where is the repo?" },
		};
		const html = renderTranscript({ entries: [entry], working: false });
		expect(html).toContain("tr-irc");
		expect(html).toContain("Where is the repo?");
		expect(html).not.toContain("<irc>");
		expect(html).not.toContain("</irc>");
		expect(html).not.toContain("Incoming IRC message from agent");
		expect(html).not.toContain("If response expected");
	});

	it("strips the wrapper from irc:incoming without details (legacy snapshots)", () => {
		const entry: SessionEntry = {
			type: "custom_message",
			id: "irc-3",
			parentId: null,
			timestamp: "2026-08-09T00:00:03Z",
			customType: "irc:incoming",
			content: "<irc>\nIncoming IRC message from agent `scoutB`:\n\nlegacy body\n</irc>",
			display: true,
			details: null,
		};
		const html = renderTranscript({ entries: [entry], working: false });
		expect(html).toContain("legacy body");
		expect(html).not.toContain("<irc>");
		expect(html).not.toContain("</irc>");
	});
});

describe("Transcript display-settings parity (TUI)", () => {
	it("hideToolActivity drops toolCall cards and running tail tools", () => {
		const html = renderTranscript({
			entries: [committedAssistantToolCall()],
			activeTools: new Map([[TOOL_CALL_ID, activeTool()]]),
			working: true,
			hideToolActivity: true,
		});
		expect(countElements(html, ".tv-card")).toBe(0);
		expect(html).not.toContain(TOOL_NAME);
		expect(html).not.toContain(ACTIVE_TOOL_TARGET);
	});

	it("showTokenUsage gates the per-turn usage row", () => {
		const settled = committedAssistantToolCall();
		if (settled.type !== "message") throw new Error("fixture must be a message entry");
		if (settled.message.role !== "assistant") throw new Error("fixture must be an assistant message");
		// duration present → this is a settled turn (the row's own gate)
		settled.message.duration = 1200;
		const on = renderTranscript({ entries: [settled], working: false, showTokenUsage: true });
		expect(countElements(on, ".tr-usage")).toBe(1);
		const off = renderTranscript({ entries: [settled], working: false });
		expect(countElements(off, ".tr-usage")).toBe(0);
	});

	it("colorBlind marks the root with data-colorblind", () => {
		const html = renderTranscript({ working: false, colorBlind: true });
		expect(html).toContain('data-colorblind="true"');
		const plain = renderTranscript({ working: false });
		expect(plain).not.toContain("data-colorblind");
	});

	it("collapseCompacted folds pre-compaction history behind a toggle row", () => {
		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "pre-1",
				parentId: null,
				timestamp: "2026-07-01T00:00:00Z",
				message: { role: "user", content: "old history", timestamp: 1 },
			},
			{
				type: "compaction",
				id: "comp-1",
				parentId: null,
				timestamp: "2026-07-01T00:01:00Z",
				summary: "sum",
				firstKeptEntryId: "post-1",
				tokensBefore: 1000,
			},
			{
				type: "message",
				id: "post-1",
				parentId: null,
				timestamp: "2026-07-01T00:02:00Z",
				message: { role: "user", content: "after compaction", timestamp: 1 },
			},
		];
		const folded = renderTranscript({ entries, working: false, collapseCompacted: true });
		expect(folded).toContain("tr-compacted-fold");
		// Pre-compaction history is hidden: only the post-compaction user
		// row renders. (Text content is not asserted — Markdown SSR renders
		// empty in this harness, a pre-existing baseline issue.)
		expect(countElements(folded, ".tr-row--user")).toBe(1);
		const unfolded = renderTranscript({ entries, working: false });
		expect(countElements(unfolded, ".tr-row--user")).toBe(2);
		expect(unfolded).not.toContain("tr-compacted-fold");
	});
});

describe("msgText (per-message copy / edit / fork source)", () => {
	it("returns a string content message in full, however long", () => {
		const long = "字".repeat(500);
		expect(msgText({ content: long })).toBe(long);
	});

	it("joins ALL text blocks without truncating", () => {
		const long = "长文本".repeat(300); // 900 chars — well past the old 200 cap
		const joined = msgText({ content: [{ type: "text", text: long }, { type: "text", text: "尾巴" }] });
		expect(joined).toBe(`${long} 尾巴`);
		expect(joined.length).toBeGreaterThan(200);
	});

	it("skips non-text blocks but keeps their neighbors", () => {
		const msg = {
			content: [
				{ type: "text", text: "开头" },
				{ type: "toolCall", id: "t1", name: "probe", arguments: {} },
				{ type: "text", text: "结尾" },
			],
		};
		expect(msgText(msg)).toBe("开头 结尾");
	});

	it("returns empty for unknown shapes", () => {
		expect(msgText({ content: 42 })).toBe("");
		expect(msgText({ content: undefined })).toBe("");
	});
});

describe("Transcript work-timer round anchoring", () => {
	it("keeps the live ticker off the previous round's message while the model is responding", () => {
		// Old round assistant(100), then user(200) sent, model not replying yet:
		// the last assistant entry does NOT belong to the current round, so no
		// "已用时 X 秒" under the wrong message — the standalone ghost row shows it.
		const html = renderTranscript({
			entries: [assistantEntry({ timestamp: 100 }), userEntry(200)],
			working: true,
		});
		expect(countElements(html, ".tr-ghost-working")).toBe(1);
		expect(countElements(html, ".tr-working")).toBe(1);
	});

	it("mounts the ticker inside the current round's assistant message once it exists", () => {
		const html = renderTranscript({
			entries: [userEntry(200), assistantEntry({ timestamp: 300 })],
			working: true,
		});
		expect(countElements(html, ".tr-ghost-working")).toBe(0);
		expect(countElements(html, ".tr-working")).toBe(1);
	});

	it("renders no work timer for idle sessions", () => {
		const html = renderTranscript({
			entries: [userEntry(200), assistantEntry({ timestamp: 300 })],
			working: false,
		});
		expect(countElements(html, ".tr-working")).toBe(0);
	});
});
