import { describe, expect, it } from "bun:test";
import type { Context } from "@musepi/pi-ai";
import { createInbandScanner, type Dialect, getDialectDefinition, type InbandScanEvent } from "@musepi/pi-ai/dialect";

/**
 * The exact bytes a Hy3 turn leaked into the transcript (recorded 2026-10-20,
 * session `01a1580a`, provider `auth-hub-codebuddy`, model `hy3`).
 *
 * Before this dialect existed every scanner treated the envelope as plain text:
 * the assistant message carried the raw markup as its `text`, no toolCall was
 * produced, and the turn stopped with `stopReason: "stop"` — the model waiting
 * for a result that would never arrive.
 */
const LEAKED_TURN = `<tool_calls:6124c78e>
<tool_call:6124c78e>read
 OPTIONS={"path":"skill://widget-design"}`;

const TOOLS = [
	{
		name: "read",
		description: "Read a file",
		parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
	},
] as unknown as NonNullable<Context["tools"]>;

function scan(text: string, chunkSize = 1): InbandScanEvent[] {
	const scanner = createInbandScanner("hunyuan", { tools: TOOLS, parseThinking: true });
	const events: InbandScanEvent[] = [];
	// Chunked feeding proves the scanner is a streaming state machine, not a
	// whole-string regex: SSE delivers this envelope across several deltas.
	for (let i = 0; i < text.length; i += chunkSize) {
		events.push(...scanner.feed(text.slice(i, i + chunkSize)));
	}
	events.push(...scanner.flush());
	return events;
}

describe("hunyuan dialect", () => {
	it("recovers the leaked Hy3 envelope as a real tool call", () => {
		const ends = scan(LEAKED_TURN).filter(e => e.type === "toolEnd");
		expect(ends).toHaveLength(1);
		const end = ends[0] as Extract<InbandScanEvent, { type: "toolEnd" }>;
		expect(end.name).toBe("read");
		expect(end.arguments).toEqual({ path: "skill://widget-design" });
		// The id the model wrote rides through, so a later result line can
		// reference the same call.
		expect(end.id).toBe("6124c78e");
	});

	it("emits no text for the envelope itself", () => {
		// The whole point: the markup must NOT reach the transcript as text.
		const text = scan(LEAKED_TURN)
			.filter((e): e is Extract<InbandScanEvent, { type: "text" }> => e.type === "text")
			.map(e => e.text)
			.join("");
		expect(text).toBe("");
	});

	it("recovers the same call regardless of SSE chunk boundaries", () => {
		// A long `path` can split mid-JSON; a scanner that only matched whole
		// strings would drop the call whenever the transport chunked it.
		for (const size of [1, 2, 3, 7, 13, 64]) {
			const ends = scan(LEAKED_TURN, size).filter(e => e.type === "toolEnd");
			expect(ends, `chunk size ${size}`).toHaveLength(1);
			const end = ends[0] as Extract<InbandScanEvent, { type: "toolEnd" }>;
			expect(end.arguments, `chunk size ${size}`).toEqual({ path: "skill://widget-design" });
		}
	});

	it("passes prose before the envelope through as text", () => {
		// The model writes a sentence, then the envelope. Dropping the sentence
		// would silently eat half the assistant's message.
		const text = scan(`我先读一下规范。\n${LEAKED_TURN}`)
			.filter((e): e is Extract<InbandScanEvent, { type: "text" }> => e.type === "text")
			.map(e => e.text)
			.join("");
		expect(text).toContain("我先读一下规范。");
		expect(text).not.toContain("tool_call");
	});

	it("parses two calls in one envelope", () => {
		const two = `<tool_calls:aa11bb22>
<tool_call:aa11bb22>read
 OPTIONS={"path":"a.ts"}
<tool_call:aa11bb22>read
 OPTIONS={"path":"b.ts"}
</tool_calls:aa11bb22>`;
		const ends = scan(two, 5).filter(e => e.type === "toolEnd") as Array<
			Extract<InbandScanEvent, { type: "toolEnd" }>
		>;
		expect(ends.map(e => e.arguments)).toEqual([{ path: "a.ts" }, { path: "b.ts" }]);
	});

	it("keeps braces inside string arguments intact", () => {
		// Depth counting must respect JSON string context, or a `}` in a code
		// argument truncates the object and the call is lost.
		const braced = `<tool_calls:cc33>
<tool_call:cc33>read
 OPTIONS={"path":"src/{a}/b.ts"}`;
		const ends = scan(braced, 4).filter(e => e.type === "toolEnd") as Array<
			Extract<InbandScanEvent, { type: "toolEnd" }>
		>;
		expect(ends[0]?.arguments).toEqual({ path: "src/{a}/b.ts" });
	});

	it("renders an envelope the same scanner reads back (round trip)", () => {
		const rendered = getDialectDefinition("hunyuan").renderAssistantToolCalls([
			{ type: "toolCall", id: "x", name: "read", arguments: { path: "a.ts" } },
		]);
		const ends = scan(rendered).filter(e => e.type === "toolEnd") as Array<
			Extract<InbandScanEvent, { type: "toolEnd" }>
		>;
		expect(ends).toHaveLength(1);
		expect(ends[0]?.name).toBe("read");
		expect(ends[0]?.arguments).toEqual({ path: "a.ts" });
	});
});

describe("preferredDialect", () => {
	it("routes the Hunyuan ids this catalog serves to the hunyuan dialect", async () => {
		// `hy3` carries no vendor token at all — without this routing the auto
		// mode would fall back to `xml`, whose tags the model never emits.
		const { preferredDialect } = await import("@musepi/pi-catalog/identity");
		expect(preferredDialect("hy3")).toBe("hunyuan" satisfies Dialect);
		expect(preferredDialect("hy3-x")).toBe("hunyuan" satisfies Dialect);
		expect(preferredDialect("hy4-preview")).toBe("hunyuan" satisfies Dialect);
		expect(preferredDialect("hunyuan-turbo")).toBe("hunyuan" satisfies Dialect);
		// Neighbouring families must not be captured by the `hy` prefix.
		expect(preferredDialect("glm-5.3")).toBe("glm");
		expect(preferredDialect("deepseek-v4-pro")).toBe("deepseek");
	});
});
