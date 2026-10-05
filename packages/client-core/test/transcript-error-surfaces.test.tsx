import { describe, expect, test } from "bun:test";
import type { SessionEntry } from "@musepi/pi-wire";
import { renderToStaticMarkup } from "react-dom/server";
import { t } from "../src/i18n/index.js";
import "./transcript-dom-shim";
import { Transcript } from "../src/components/transcript/Transcript";

/**
 * One terminal retry failure is written twice: into the assistant message and into
 * a durable retry_failure row. Rendering both showed the same 429 three times over
 * in practice — once as the assistant row, once in the card, once in the card's
 * folded detail. The assistant row also took the orb and the reply's alignment, so
 * a request-level fact read as something the agent said.
 *
 * The turn-level surface is now the message's own body: no card, no orb, and the
 * retry row's attempt count merged onto it so nothing is lost when the row stops
 * rendering. These cases assert what the user sees in the transcript; the
 * session-level dock is covered in session-error-dock.test.tsx.
 */
const REASON = "429 insufficient balance, top up required";

function entries(assistantReason: string, retryReason: string, attempt: number): SessionEntry[] {
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
			message: { role: "assistant", content: [], stopReason: "error", errorMessage: assistantReason, timestamp: 2 },
		} as unknown as SessionEntry,
		{
			type: "custom_message",
			id: "retry-1",
			parentId: null,
			customType: "retry_failure",
			content: retryReason,
			details: { attempt },
			timestamp: "2026-10-05T00:00:02Z",
			display: true,
		} as unknown as SessionEntry,
	];
}

const render = (reason: string, attempt = 2): string =>
	renderToStaticMarkup(
		<Transcript
			entries={entries(reason, reason, attempt)}
			stream={null}
			streamDone={true}
			activeTools={new Map()}
			working={false}
		/>,
	);

describe("transcript error surfaces", () => {
	test("shows one failure reason once even though two rows carry it", () => {
		// The regression: the reason appeared in the assistant row and again in the
		// retry card, so a single 429 read as two separate problems.
		const html = render(REASON);
		const occurrences = html.split(REASON).length - 1;

		expect(occurrences).toBe(1);
	});

	test("moves the retry count onto the body that took the reason", () => {
		// The retry row no longer renders, so the attempt count it alone knew would
		// vanish with it. A reader who cannot tell one attempt from three cannot tell
		// a transient blip from a provider that is down.
		const html = render(REASON, 3);

		expect(html).toContain(t("retry attempt {count}", { count: "3" }));
	});

	test("renders no bordered card for a failed turn", () => {
		// The card was the loud part: a red block of monospace that read as an alarm
		// rather than a record. Its absence is the presentation change itself.
		const html = render(REASON);

		expect(html).not.toContain("tr-stop");
		expect(html).not.toContain("tr-retry-failure");
		expect(html).not.toContain("tr-retry-note");
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

	test("drops a retry row the assistant row did not claim, for the dock to report", () => {
		// Different text means two separate failures. The retry row still leaves the
		// transcript — the dock above the composer reports it — because a row in the
		// message flow is not where a session-level failure belongs.
		const html = renderToStaticMarkup(
			<Transcript
				entries={entries(REASON, "socket connection was closed unexpectedly", 2)}
				stream={null}
				streamDone={true}
				activeTools={new Map()}
				working={false}
			/>,
		);

		expect(html).toContain(REASON);
		expect(html).not.toContain("socket connection was closed unexpectedly");
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

	test("shows an interrupted turn as an interruption, not a failure", () => {
		// A stop the user asked for is not an error. Rendering both under the same
		// "request failed" heading would make an intentional stop read as a fault.
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
						id: "assistant-stop",
						parentId: null,
						timestamp: "2026-10-05T00:00:01Z",
						message: {
							role: "assistant",
							content: [{ type: "text", text: "partial answer" }],
							stopReason: "aborted",
							errorMessage: "aborted",
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

		expect(html).toContain(t("request interrupted"));
		expect(html).not.toContain(t("request failed"));
	});
});
