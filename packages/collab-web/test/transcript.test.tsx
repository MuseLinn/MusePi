import { describe, expect, it } from "bun:test";
import type { AssistantMessage, SessionEntry } from "@musepi/pi-wire";
import { renderToStaticMarkup } from "react-dom/server";
import "./transcript-dom-shim";
import { Transcript } from "../src/components/transcript/Transcript";
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

function renderTranscript(props: {
	entries?: readonly SessionEntry[];
	activeTools?: ReadonlyMap<string, ActiveTool>;
	working: boolean;
}): string {
	return renderToStaticMarkup(
		<Transcript
			entries={props.entries ?? []}
			stream={null}
			streamDone={true}
			activeTools={props.activeTools ?? new Map()}
			working={props.working}
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

		expect(countElements(html, ".tv-card")).toBe(1);
		expect(countElements(html, '[aria-label="running"]')).toBe(1);
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
});
