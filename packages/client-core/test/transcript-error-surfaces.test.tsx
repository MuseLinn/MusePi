import { describe, expect, test } from "bun:test";
import type { SessionEntry } from "@musepi/pi-wire";
import { renderToStaticMarkup } from "react-dom/server";
import "./transcript-dom-shim";
import { Transcript } from "../src/components/transcript/Transcript";

/**
 * One terminal retry failure is written twice: into the assistant message and into
 * a durable retry_failure row. Rendering both showed the same 429 three times over
 * in practice — once as the assistant row, once in the card, once in the card's
 * folded detail. The assistant row also took the orb and the reply's alignment, so
 * a request-level fact read as something the agent said.
 *
 * These cases assert what the user sees, not which branch renders it: the reason
 * appears exactly once, the retry row keeps the one thing only it knows, and a
 * turn that produced no reply does not wear the assistant row's chrome.
 */
const REASON = "429 insufficient balance, top up required";

function entries(reason: string): SessionEntry[] {
	return [
		{
			type: "message",
			id: "user-1",
			parentId: null,
			timestamp: "2026-10-05T00:00:00Z",
			message: { role: "user", content: "hello?", timestamp: 1 },
		} as unknown as SessionEntry,
		{
			type: "message",
			id: "assistant-err",
			parentId: null,
			timestamp: "2026-10-05T00:00:01Z",
			message: { role: "assistant", content: [], stopReason: "error", errorMessage: reason, timestamp: 2 },
		} as unknown as SessionEntry,
		{
			type: "custom_message",
			id: "retry-1",
			parentId: null,
			customType: "retry_failure",
			content: reason,
			timestamp: "2026-10-05T00:00:02Z",
			display: true,
		} as unknown as SessionEntry,
	];
}

const render = (reason: string): string =>
	renderToStaticMarkup(
		<Transcript entries={entries(reason)} stream={null} streamDone={true} activeTools={new Map()} working={false} />,
	);

describe("transcript error surfaces", () => {
	test("shows one failure reason once even though two rows carry it", () => {
		// The regression: the reason appeared in the assistant row and again in the
		// retry card, so a single 429 read as two separate problems.
		const html = render(REASON);
		const occurrences = html.split(REASON).length - 1;

		expect(occurrences).toBe(1);
	});

	test("keeps the retry count the assistant row cannot know", () => {
		// Withholding the reason must not cost the fact only the retry row has. The
		// reduced form is a plain dim line — reusing the bordered card would leave a
		// box with one word in it, which is what the on-device screenshot showed.
		const html = render(REASON);

		expect(html).toContain("tr-retry-note");
		// The bordered card is the unreduced form and must not appear here.
		expect(html).not.toContain("tr-retry-failure");
		expect(html).toContain("2");
	});

	test("an error-only turn leaves no empty bordered box behind", () => {
		// Regression: suppressing the reason made ErrorNotice render null while its
		// bordered wrapper still painted, so the row collapsed to an empty card.
		const html = render(REASON);

		expect(html).not.toMatch(/tr-retry-failure[^"]*"><\/\w+>/);
	});

	test("still shows a retry card that reports something the assistant row did not", () => {
		// Different text means two separate failures, not one written twice — the
		// earlier card must stay visible in full.
		const html = render("socket connection was closed unexpectedly");

		expect(html).toContain("socket connection was closed unexpectedly");
	});

	test("does not give an error-only turn the assistant row's chrome", () => {
		// A turn with no reply has nothing to attribute to the agent, so it must not
		// render as an assistant row — that framing is what made a request-level
		// failure read as the model having said it. Asserted on the row kind rather
		// than on the gutter, which every row carries.
		const html = render(REASON);

		expect(html).not.toContain("tr-row--assistant");
		expect(html).toContain("tr-row--custom");
	});

	test("still renders a normal assistant turn as an assistant row", () => {
		// The negative assertion above is only meaningful if normal turns still take
		// the assistant row — otherwise it would pass on a transcript that never
		// renders a reply at all.
		const html = renderToStaticMarkup(
			<Transcript
				entries={[
					{
						type: "message",
						id: "user-1",
						parentId: null,
						timestamp: "2026-10-05T00:00:00Z",
						message: { role: "user", content: "hello?", timestamp: 1 },
					} as unknown as SessionEntry,
					{
						type: "message",
						id: "assistant-ok",
						parentId: null,
						timestamp: "2026-10-05T00:00:01Z",
						message: {
							role: "assistant",
							content: [{ type: "text", text: "a real reply" }],
							stopReason: "stop",
							timestamp: 2,
						},
					} as unknown as SessionEntry,
				]}
				stream={null}
				streamDone={true}
				activeTools={new Map()}
				working={false}
			/>,
		);

		expect(html).toContain("tr-row--assistant");
	});
});
