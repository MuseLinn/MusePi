/**
 * 会话 reading preferences: the four-tier policy, the default that reproduces
 * the pre-preference transcript, deferred collapse, folded replies, and the
 * three settings rows that persist the choice.
 */
import "./happy-dom-shim"; // MUST be first: installs the DOM globals.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { t } from "@musepi/client-core";
import {
	presentationPolicyFor,
	transcriptPresentationPolicy,
} from "@musepi/client-core/src/components/transcript/presentation-policy";
import {
	buildRoundFolds,
	foldDefaultOpen,
	foldSpan,
	isInsideFold,
} from "@musepi/client-core/src/components/transcript/round-collapse";
import {
	COLLAPSE_TIMING_KEY,
	FOLDED_REPLIES_KEY,
	readTranscriptPrefs,
	setCollapseTiming,
	setFoldedReplies,
	setTranscriptView,
	TRANSCRIPT_PREFS_CHANGED_EVENT,
	TRANSCRIPT_VIEW_KEY,
} from "@musepi/client-core/src/components/transcript/transcript-prefs";
import {
	createTurnDeriveCache,
	deriveTurns,
	deriveTurnsUncached,
} from "@musepi/client-core/src/components/transcript/turn-derive";
import type { SessionEntry } from "@musepi/pi-wire";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TranscriptReadingSection } from "../src/components/settings-sections/chat";

// ── Fixtures ─────────────────────────────────────────────────────────────

const base = { parentId: null, timestamp: "0" };
let seq = 0;

function withId(overrides: object): SessionEntry {
	return { ...base, id: `p${++seq}`, ...overrides } as unknown as SessionEntry;
}

const userMsg = (text = "hi"): SessionEntry =>
	withId({ type: "message", message: { role: "user", content: text, timestamp: 1 } });

const assistantText = (text = "ok"): SessionEntry =>
	withId({ type: "message", message: { role: "assistant", content: [{ type: "text", text }], timestamp: 1 } });

const assistantToolCall = (id: string): SessionEntry =>
	withId({
		type: "message",
		message: { role: "assistant", content: [{ type: "toolCall", id, name: "read", arguments: {} }], timestamp: 1 },
	});

const toolResult = (toolCallId: string): SessionEntry =>
	withId({
		type: "message",
		message: {
			role: "toolResult",
			toolCallId,
			toolName: "read",
			content: [{ type: "text", text: "out" }],
			isError: false,
			timestamp: 1,
		},
	});

/** One round with two tool steps and an intermediate reply before the final
 *  answer — the shape `foldedReplies` decides about. */
function twoStepRound(): SessionEntry[] {
	return [
		userMsg("do the thing"),
		assistantToolCall("c1"),
		toolResult("c1"),
		assistantText("intermediate finding"),
		assistantToolCall("c2"),
		toolResult("c2"),
		assistantText("final answer"),
	];
}

// ── Policy ───────────────────────────────────────────────────────────────

describe("transcript presentation policy", () => {
	it("maps the four modes to their capabilities", () => {
		expect(presentationPolicyFor("compact")).toMatchObject({
			mode: "compact",
			foldCompletedTurns: true,
			stepGrouping: "collapsed",
			deferTrailingFold: false,
			liveProcessDetail: false,
			settledReasoningPreview: false,
		});
		expect(presentationPolicyFor("standard")).toMatchObject({
			mode: "standard",
			foldCompletedTurns: true,
			stepGrouping: "collapsed",
			deferTrailingFold: false,
			liveProcessDetail: true,
			settledReasoningPreview: true,
		});
		expect(presentationPolicyFor("detailed")).toMatchObject({
			mode: "detailed",
			foldCompletedTurns: true,
			stepGrouping: "history",
			deferTrailingFold: false,
			liveProcessDetail: true,
			settledReasoningPreview: true,
		});
		expect(presentationPolicyFor("verbose")).toMatchObject({
			mode: "verbose",
			foldCompletedTurns: false,
			stepGrouping: "none",
			deferTrailingFold: false,
			liveProcessDetail: false,
			settledReasoningPreview: true,
		});
		// Every mode defers the trailing round under next-input — the timing
		// is independent of the grouping choice.
		for (const mode of ["compact", "standard", "detailed", "verbose"] as const) {
			expect(presentationPolicyFor(mode, "next-input").deferTrailingFold).toBe(true);
			expect(presentationPolicyFor(mode, "completion").deferTrailingFold).toBe(false);
		}
	});

	it("defaults to the behavior the transcript had before these preferences", () => {
		const policy = presentationPolicyFor("detailed");
		expect(policy.collapseTiming).toBe("completion");
		expect(policy.foldedReplies).toBe("final");
		expect(policy.deferTrailingFold).toBe(false);
		expect(presentationPolicyFor("detailed", "completion", "final")).toBe(policy);
		expect(presentationPolicyFor("detailed", "completion")).toBe(policy);
	});

	it("returns a stable object per choice and keeps all sixteen distinct", () => {
		const policies = new Set<object>();
		for (const mode of ["compact", "standard", "detailed", "verbose"] as const) {
			for (const timing of ["completion", "next-input"] as const) {
				for (const replies of ["all", "final"] as const) {
					const policy = presentationPolicyFor(mode, timing, replies);
					expect(presentationPolicyFor(mode, timing, replies)).toBe(policy);
					policies.add(policy);
				}
			}
			expect(presentationPolicyFor(mode, "next-input")).not.toBe(presentationPolicyFor(mode, "completion"));
			expect(presentationPolicyFor(mode, "completion", "all")).not.toBe(
				presentationPolicyFor(mode, "completion", "final"),
			);
		}
		expect(policies.size).toBe(16);
	});

	it("derives the live policy from the stored preferences", () => {
		setTranscriptView("verbose");
		setCollapseTiming("next-input");
		setFoldedReplies("all");
		expect(transcriptPresentationPolicy()).toBe(presentationPolicyFor("verbose", "next-input", "all"));
	});
});

// ── Default equivalence ──────────────────────────────────────────────────

describe("default reading equals the previous fixed collapse policy", () => {
	it("folds the finished last round only once the agent stops", () => {
		const entries = twoStepRound();
		const folds = buildRoundFolds(entries, false);
		expect(folds).toHaveLength(1);
		expect(buildRoundFolds(entries, false)).toEqual(
			buildRoundFolds(entries, false, presentationPolicyFor("detailed", "completion", "final")),
		);
		// The running round streams flat (the old behavior).
		expect(buildRoundFolds(entries, true)).toHaveLength(0);
		// The finished round folds closed: no deferral, global default decides.
		const fold = folds[0]!;
		expect(fold.deferred).toBe(false);
		expect(foldDefaultOpen(fold, { working: false, lastEntryIdx: entries.length - 1, defaultExpanded: false })).toBe(
			false,
		);
	});

	it("keeps only the final reply visible by default", () => {
		const folds = buildRoundFolds(twoStepRound(), false);
		const fold = folds[0]!;
		expect(fold.finalIdx).toBe(6);
		expect(fold.replies).toEqual([]);
		// Intermediate reply and process rows fold; the final answer does not.
		expect(isInsideFold(folds, 3)).toBe(true);
		expect(isInsideFold(folds, 1)).toBe(true);
		expect(isInsideFold(folds, 6)).toBe(false);
	});

	it("verbose folds nothing, and compact folds even the running round", () => {
		const entries = twoStepRound();
		expect(buildRoundFolds(entries, false, presentationPolicyFor("verbose"))).toHaveLength(0);
		expect(buildRoundFolds(entries, true, presentationPolicyFor("compact"))).toHaveLength(1);
		expect(buildRoundFolds(entries, true, presentationPolicyFor("standard"))).toHaveLength(1);
	});
});

// ── Collapse timing ──────────────────────────────────────────────────────

describe("collapseTiming=next-input defers the latest completed round", () => {
	it("keeps the finished last round expanded until a later user message exists", () => {
		const deferred = presentationPolicyFor("detailed", "next-input");
		expect(buildRoundFolds(twoStepRound(), false, deferred)).toHaveLength(0);
		expect(buildRoundFolds(twoStepRound(), true, deferred)).toHaveLength(0);
	});

	it("folds the earlier round once the next user message turns it into history", () => {
		const deferred = presentationPolicyFor("detailed", "next-input");
		const entries = [...twoStepRound(), userMsg("next question"), assistantText("next answer")];
		const folds = buildRoundFolds(entries, true, deferred);
		expect(folds).toHaveLength(1);
		expect(folds[0]!.startIdx).toBe(0);
		expect(folds[0]!.endIdx).toBe(6);
		// The new trailing round is still flat.
		expect(folds.some(fold => fold.startIdx === 7)).toBe(false);
	});

	it("completion folds the same round immediately", () => {
		const immediate = presentationPolicyFor("detailed", "completion");
		const entries = [...twoStepRound(), userMsg("next question"), assistantText("next answer")];
		const folds = buildRoundFolds(entries, false, immediate);
		expect(folds).toHaveLength(1);
		expect(folds[0]!.startIdx).toBe(0);
	});
});

// ── Grouping modes + next-input (running round stays open) ───────────────

describe("grouping modes defer the trailing fold instead of hiding it", () => {
	it.each(["compact", "standard"] as const)(
		"%s keeps a running group open and defers the finished one (builder)",
		mode => {
			const entries = twoStepRound();
			const lastEntryIdx = entries.length - 1;
			const deferred = presentationPolicyFor(mode, "next-input");
			expect(deferred.deferTrailingFold).toBe(true);
			expect(deferred.stepGrouping).toBe("collapsed");

			// Running: the header groups the in-flight round but must not hide
			// its process (dsh turnClosed === false → always open).
			const running = buildRoundFolds(entries, true, deferred);
			expect(running).toHaveLength(1);
			expect(running[0]!.deferred).toBe(false);
			expect(foldDefaultOpen(running[0]!, { working: true, lastEntryIdx, defaultExpanded: false })).toBe(true);

			// Finished: the round stays open until the next prompt.
			const idle = buildRoundFolds(entries, false, deferred);
			expect(idle).toHaveLength(1);
			expect(idle[0]!.deferred).toBe(true);
			expect(foldDefaultOpen(idle[0]!, { working: false, lastEntryIdx, defaultExpanded: false })).toBe(true);

			// Next prompt: the earlier round is history and closes under the
			// global default; the new trailing round has no work to fold.
			const history = [...entries, userMsg("next question"), assistantText("next answer")];
			const folds = buildRoundFolds(history, false, deferred);
			expect(folds).toHaveLength(1);
			expect(folds[0]!.deferred).toBe(false);
			expect(
				foldDefaultOpen(folds[0]!, {
					working: false,
					lastEntryIdx: history.length - 1,
					defaultExpanded: false,
				}),
			).toBe(false);

			// completion closes the finished trailing round immediately.
			const completed = buildRoundFolds(entries, false, presentationPolicyFor(mode, "completion"))[0]!;
			expect(completed.deferred).toBe(false);
			expect(foldDefaultOpen(completed, { working: false, lastEntryIdx, defaultExpanded: false })).toBe(false);
		},
	);

	it.each(["compact", "standard"] as const)("%s materializes the deferred fold in deriveTurns", mode => {
		const entries = twoStepRound();
		const cache = createTurnDeriveCache();
		const deferred = presentationPolicyFor(mode, "next-input");
		const idle = deriveTurns(entries, false, cache, deferred);
		expect(idle.folds).toHaveLength(1);
		expect(idle.folds[0]!.deferred).toBe(true);
		expect(idle.folds).toEqual(deriveTurnsUncached(entries, false, deferred).folds);

		const running = deriveTurns(entries, true, cache, deferred);
		expect(running.folds).toHaveLength(1);
		expect(running.folds[0]!.deferred).toBe(false);

		const completed = deriveTurns(entries, false, cache, presentationPolicyFor(mode, "completion"));
		expect(completed.folds[0]!.deferred).toBe(false);
	});

	it("opens only the running group, not earlier history", () => {
		const entries = [
			...twoStepRound(),
			userMsg("next question"),
			assistantToolCall("c3"),
			toolResult("c3"),
			assistantText("next answer"),
		];
		const folds = buildRoundFolds(entries, true, presentationPolicyFor("compact", "completion"));
		expect(folds).toHaveLength(2);
		const options = { working: true, lastEntryIdx: entries.length - 1, defaultExpanded: false };
		expect(foldDefaultOpen(folds[0]!, options)).toBe(false);
		expect(foldDefaultOpen(folds[1]!, options)).toBe(true);
	});

	it("detailed next-input still leaves the trailing round flat", () => {
		expect(buildRoundFolds(twoStepRound(), false, presentationPolicyFor("detailed", "next-input"))).toHaveLength(0);
		expect(
			deriveTurns(twoStepRound(), false, createTurnDeriveCache(), presentationPolicyFor("detailed", "next-input"))
				.folds,
		).toHaveLength(0);
	});
});

// ── Folded replies ───────────────────────────────────────────────────────

describe("foldedReplies", () => {
	it("keeps every assistant reply visible when set to all", () => {
		const entries = twoStepRound();
		const folds = buildRoundFolds(entries, false, presentationPolicyFor("detailed", "completion", "all"));
		const fold = folds[0]!;
		expect(fold.replies).toEqual([3]);
		expect(isInsideFold(folds, 3)).toBe(false);
		// Process rows still fold, and the final answer is still visible.
		expect(isInsideFold(folds, 1)).toBe(true);
		expect(isInsideFold(folds, 2)).toBe(true);
		expect(isInsideFold(folds, 4)).toBe(true);
		expect(isInsideFold(folds, 5)).toBe(true);
		expect(isInsideFold(folds, 6)).toBe(false);
	});

	it("exposes the kept reply in the relative span", () => {
		const span = foldSpan(twoStepRound(), 0, null, 6, "all");
		expect(span?.repliesRel).toEqual([3]);
		expect(foldSpan(twoStepRound(), 0, null, 6, "final")?.repliesRel).toEqual([]);
	});

	it("rebuilds folds when the reply preference changes under a warm cache", () => {
		const entries = twoStepRound();
		const cache = createTurnDeriveCache();
		const kept = deriveTurns(entries, false, cache, presentationPolicyFor("detailed", "completion", "final"));
		const all = deriveTurns(entries, false, cache, presentationPolicyFor("detailed", "completion", "all"));
		expect(kept.folds[0]!.replies).toEqual([]);
		expect(all.folds[0]!.replies).toEqual([3]);
	});
});

// ── Persisted preferences + settings rows ───────────────────────────────

describe("transcript preferences", () => {
	beforeEach(() => {
		localStorage.clear();
	});

	it("falls back to the defaults for missing or unknown stored values", () => {
		expect(readTranscriptPrefs()).toEqual({
			transcriptView: "detailed",
			collapseTiming: "completion",
			foldedReplies: "final",
		});
		localStorage.setItem(TRANSCRIPT_VIEW_KEY, "normal");
		localStorage.setItem(COLLAPSE_TIMING_KEY, "later");
		localStorage.setItem(FOLDED_REPLIES_KEY, "some");
		expect(readTranscriptPrefs()).toEqual({
			transcriptView: "detailed",
			collapseTiming: "completion",
			foldedReplies: "final",
		});
	});

	it("persists each preference and notifies same-document readers", () => {
		let events = 0;
		const listener = (): void => {
			events++;
		};
		window.addEventListener(TRANSCRIPT_PREFS_CHANGED_EVENT, listener);
		setTranscriptView("compact");
		setCollapseTiming("next-input");
		setFoldedReplies("all");
		window.removeEventListener(TRANSCRIPT_PREFS_CHANGED_EVENT, listener);
		expect(readTranscriptPrefs()).toEqual({
			transcriptView: "compact",
			collapseTiming: "next-input",
			foldedReplies: "all",
		});
		expect(events).toBe(3);
	});

	it("keeps the chosen value when storage rejects writes", () => {
		// happy-dom's WebIDL storage cannot be patched per method, so swap the
		// global for a stub that accepts reads but refuses writes.
		const realStorage = globalThis.localStorage;
		const stored = new Map<string, string>();
		const stub = {
			getItem: (key: string): string | null => stored.get(key) ?? null,
			setItem: (): void => {
				throw new Error("blocked");
			},
			removeItem: (): void => {},
			clear: (): void => {
				stored.clear();
			},
		} as unknown as Storage;
		Object.defineProperty(globalThis, "localStorage", { configurable: true, value: stub });
		try {
			setTranscriptView("compact");
			setCollapseTiming("next-input");
			// The mirror carries the choice even though nothing was stored.
			expect(readTranscriptPrefs()).toMatchObject({ transcriptView: "compact", collapseTiming: "next-input" });
			expect(stored.size).toBe(0);
		} finally {
			Object.defineProperty(globalThis, "localStorage", { configurable: true, value: realStorage });
			// A successful write re-syncs the mirror and clears the unsynced mark.
			setTranscriptView("detailed");
			setCollapseTiming("completion");
		}
	});
});

describe("settings 会话 rows", () => {
	let root: Root | null = null;
	let host: HTMLDivElement | null = null;

	beforeEach(() => {
		localStorage.clear();
	});

	afterEach(() => {
		if (root) act(() => root?.unmount());
		root = null;
		host?.remove();
		host = null;
		localStorage.clear();
	});

	function mount(): HTMLDivElement {
		const el = document.createElement("div");
		document.body.appendChild(el);
		root = createRoot(el);
		act(() => {
			root?.render(<TranscriptReadingSection />);
		});
		host = el;
		return el;
	}

	function buttonByText(scope: HTMLElement, label: string): HTMLButtonElement {
		const button = [...scope.querySelectorAll("button")].find(b => b.textContent?.trim() === label);
		if (!button) throw new Error(`no button labelled "${label}"`);
		return button;
	}

	it("renders the three rows with the stored choice", () => {
		localStorage.setItem(TRANSCRIPT_VIEW_KEY, "compact");
		const scope = mount();
		expect(scope.querySelector(".gui-select-trigger")?.textContent).toBe(t("general.transcriptViewCompact"));
		expect(scope.textContent).toContain(t("general.collapseTiming"));
		expect(scope.textContent).toContain(t("general.foldedReplies"));
		expect(scope.textContent).not.toContain("general.");
	});

	it("persists a collapsed timing and reply choice from the rows", () => {
		const scope = mount();
		act(() => buttonByText(scope, t("general.collapseTimingNextInput")).click());
		expect(localStorage.getItem(COLLAPSE_TIMING_KEY)).toBe("next-input");
		act(() => buttonByText(scope, t("general.foldedRepliesAll")).click());
		expect(localStorage.getItem(FOLDED_REPLIES_KEY)).toBe("all");
	});

	it("persists the work-details level from the dropdown", () => {
		const scope = mount();
		const trigger = scope.querySelector<HTMLElement>(".gui-select-trigger");
		if (!trigger) throw new Error("no work-details trigger");
		act(() => trigger.click());
		const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
			node => node.textContent?.trim() === t("general.transcriptViewVerbose"),
		);
		if (!option) throw new Error("no verbose option");
		act(() => option.click());
		expect(localStorage.getItem(TRANSCRIPT_VIEW_KEY)).toBe("verbose");
	});
});
