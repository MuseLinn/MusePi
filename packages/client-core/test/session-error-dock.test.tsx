import { describe, expect, test } from "bun:test";
import type { SessionEntry } from "@musepi/pi-wire";
import { renderToStaticMarkup } from "react-dom/server";
import {
	readRetryBanner,
	readUnansweredCandidate,
	SessionErrorDock,
	scheduleUnansweredRechecks,
	UNANSWERED_AFTER_MS,
	UNANSWERED_RECHECK_DELAYS_MS,
} from "../src/components/transcript/session-error-dock";
import { t } from "../src/i18n/index.js";
import "./transcript-dom-shim";

/**
 * The dock above the composer reports two things the transcript cannot: a round the
 * runtime gave up on, and a round that produced nothing at all.
 *
 * The second is the interesting one. It is a guess — the store may simply have
 * missed the reply — so it must be checkable, and the check must not be able to
 * hide a genuine silence. These cases pin both the verdicts and the re-read that
 * backs them.
 */
const userPrompt = (id: string, iso = "2026-10-05T00:00:00Z"): SessionEntry =>
	({
		type: "message",
		id,
		parentId: null,
		timestamp: iso,
		message: { role: "user", content: [{ type: "text", text: "go" }], timestamp: 1 },
	}) as unknown as SessionEntry;

const assistantReply = (id: string): SessionEntry =>
	({
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-10-05T00:00:01Z",
		message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop", timestamp: 2 },
	}) as unknown as SessionEntry;

const assistantError = (id: string, text: string): SessionEntry =>
	({
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-10-05T00:00:01Z",
		message: { role: "assistant", content: [], stopReason: "error", errorMessage: text, timestamp: 2 },
	}) as unknown as SessionEntry;

const retryRow = (id: string, text: string, attempt?: number): SessionEntry =>
	({
		type: "custom_message",
		id,
		parentId: null,
		customType: "retry_failure",
		content: text,
		timestamp: "2026-10-05T00:00:02Z",
		display: true,
		...(attempt === undefined ? {} : { details: { attempt } }),
	}) as unknown as SessionEntry;

describe("readRetryBanner", () => {
	test("reports an unclaimed retry failure with its attempt count", () => {
		expect(readRetryBanner([retryRow("c1", "429 insufficient balance", 4)])).toEqual({
			reason: "429 insufficient balance",
			attempt: 4,
		});
	});

	test("stays quiet once the transcript already shows the reason", () => {
		// Two accounts of one failure is what this dock exists to avoid: the assistant
		// row is already in the message flow carrying it.
		const reason = "429 insufficient balance";
		expect(readRetryBanner([assistantError("a1", reason), retryRow("c1", reason, 4)])).toBeNull();
	});

	test("stays quiet after the user sends again", () => {
		expect(readRetryBanner([retryRow("c1", "429"), userPrompt("u1")])).toBeNull();
	});

	test("reports nothing for a healthy transcript", () => {
		expect(readRetryBanner([userPrompt("u1"), assistantReply("a1")])).toBeNull();
	});
});

describe("readUnansweredCandidate", () => {
	test("flags a prompt the session is idle on", () => {
		const candidate = readUnansweredCandidate([userPrompt("u1")], false);

		expect(candidate).not.toBeNull();
		expect(candidate?.key).toBe("u1");
	});

	test("stays quiet while the session is working", () => {
		// A slow round is working, not stalled. Flagging it would put a notice over a
		// turn that is about to answer.
		expect(readUnansweredCandidate([userPrompt("u1")], true)).toBeNull();
	});

	test("stays quiet once a reply landed", () => {
		expect(readUnansweredCandidate([userPrompt("u1"), assistantReply("a1")], false)).toBeNull();
	});

	test("stays quiet when the transcript already explains the round", () => {
		// The user has been told why; a silence notice on top restates it as though
		// nothing had been reported.
		expect(readUnansweredCandidate([userPrompt("u1"), assistantError("a1", "socket closed")], false)).toBeNull();
	});

	test("stays quiet when the retry dock already has the story", () => {
		expect(readUnansweredCandidate([userPrompt("u1"), retryRow("c1", "429")], false)).toBeNull();
	});

	test("rejects a prompt with no usable timestamp", () => {
		// Date.parse of a malformed stamp is NaN, and a candidate keyed on NaN would
		// never reach its 5s deadline — the notice would simply never appear.
		const bad = {
			type: "message",
			id: "u1",
			parentId: null,
			timestamp: "not-a-date",
			message: { role: "user", content: [{ type: "text", text: "go" }], timestamp: 1 },
		} as unknown as SessionEntry;

		expect(readUnansweredCandidate([bad], false)).toBeNull();
	});

	test("keys on the prompt id so a new send starts its own wait", () => {
		// Keyed on a moment instead, the second prompt would inherit the first one's
		// verification and show a notice with no check behind it.
		const first = readUnansweredCandidate([userPrompt("u1")], false);
		const second = readUnansweredCandidate([userPrompt("u1"), userPrompt("u2")], false);

		expect(first?.key).toBe("u1");
		expect(second?.key).toBe("u2");
	});
});

describe("scheduleUnansweredRechecks", () => {
	function fakeScheduler() {
		const pending: { at: number; fire: () => void }[] = [];
		return {
			pending,
			scheduler: {
				setTimeout(callback: () => void, ms: number) {
					pending.push({ at: ms, fire: callback });
					return pending.length;
				},
				clearTimeout() {},
			},
		};
	}

	test("re-reads at each scheduled offset", () => {
		// A missed stream can drop the reply at any point in the round, so one read is
		// not enough to call a stall real.
		const { pending, scheduler } = fakeScheduler();
		let reads = 0;

		scheduleUnansweredRechecks(() => {
			reads++;
		}, scheduler);
		for (const entry of pending) entry.fire();

		expect(reads).toBe(UNANSWERED_RECHECK_DELAYS_MS.length);
		expect(pending.map(entry => entry.at)).toEqual([...UNANSWERED_RECHECK_DELAYS_MS]);
	});

	test("settles after a read that fails, so a broken check cannot hide a silence", () => {
		// The daemon being unreachable is not evidence the reply arrived. Reading it
		// the other way would leave a genuinely stalled turn with no notice at all.
		const { pending, scheduler } = fakeScheduler();
		let settled = 0;

		scheduleUnansweredRechecks(
			() => Promise.reject(new Error("daemon gone")),
			scheduler,
			() => {
				settled++;
			},
			[0],
		);
		pending[0]?.fire();

		return Promise.resolve().then(() => {
			expect(settled).toBe(1);
		});
	});

	test("ignores a read that settles after cancellation", async () => {
		// Otherwise a read started for a prompt the user has already superseded would
		// decide the verdict for the prompt on screen.
		const { pending, scheduler } = fakeScheduler();
		let settled = 0;
		// Held in an object rather than a plain `let`: control-flow analysis narrows a
		// local to its initial value when the assignment lives inside a callback.
		const gate: { release: (() => void) | null } = { release: null };

		const stop = scheduleUnansweredRechecks(
			() =>
				new Promise<void>(resolve => {
					gate.release = resolve;
				}),
			scheduler,
			() => {
				settled++;
			},
			[0],
		);
		pending[0]?.fire();
		stop();
		gate.release?.();
		await Promise.resolve();
		await Promise.resolve();

		expect(settled).toBe(0);
	});
});

describe("SessionErrorDock", () => {
	test("docks the retry failure above the composer with its attempt count", () => {
		const html = renderToStaticMarkup(
			<SessionErrorDock entries={[retryRow("c1", "429 insufficient balance", 4)]} working={false} />,
		);

		expect(html).toContain("tr-error-banner");
		expect(html).toContain("429 insufficient balance");
		expect(html).toContain(t("retry attempt {count}", { count: "4" }));
	});

	test("announces politely rather than interrupting", () => {
		// role="alert" would cut across whatever the transcript was saying, for a fact
		// about a round that finished before the dock appeared.
		const html = renderToStaticMarkup(<SessionErrorDock entries={[retryRow("c1", "429")]} working={false} />);

		expect(html).toContain('role="status"');
		expect(html).not.toContain('role="alert"');
	});

	test("renders nothing for a healthy transcript", () => {
		const html = renderToStaticMarkup(
			<SessionErrorDock entries={[userPrompt("u1"), assistantReply("a1")]} working={false} />,
		);

		expect(html).toBe("");
	});

	test("folds a long provider body instead of filling the dock", () => {
		// A provider body can be a whole response envelope; shown whole it would push
		// the composer off screen.
		const html = renderToStaticMarkup(
			<SessionErrorDock entries={[retryRow("c1", "z".repeat(3_000))]} working={false} />,
		);

		expect(html).toContain("tr-error-fold-toggle");
		expect(html).toContain(t("show more"));
		expect(html).not.toContain("z".repeat(3_000));
	});

	test("withholds the no-reply notice until it has been checked", () => {
		// Without a re-read there is no way to tell a dropped stream from a real
		// silence, and a notice in front of an answered turn is worse than none.
		const html = renderToStaticMarkup(
			<SessionErrorDock entries={[userPrompt("u1")]} working={false} verifyTranscript={() => {}} />,
		);

		expect(html).toBe("");
	});

	test("the quiet period is long enough to outlast a slow first token", () => {
		expect(UNANSWERED_AFTER_MS).toBeGreaterThanOrEqual(5_000);
	});
});
