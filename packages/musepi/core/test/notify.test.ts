// ============================================================
// notify.ts tests — OSC 9 terminal notifications (kimi port)
// ============================================================

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	BEL,
	buildTerminalNotificationSequences,
	ESC,
	formatNotification,
	isInsideTmux,
	notifyTerminalOnce,
	supportsOsc9Notification,
} from "../src/notify.ts";

describe("supportsOsc9Notification", () => {
	it("allow-lists known-good TERM_PROGRAMs", () => {
		for (const termProgram of ["iTerm.app", "WezTerm", "ghostty", "WarpTerminal"]) {
			assert.equal(supportsOsc9Notification({ TERM_PROGRAM: termProgram }), true, termProgram);
		}
	});

	it("allow-lists kitty/ghostty TERM values", () => {
		assert.equal(supportsOsc9Notification({ TERM: "xterm-kitty" }), true);
		assert.equal(supportsOsc9Notification({ TERM: "xterm-ghostty" }), true);
	});

	it("rejects unknown terminals (BEL fallback)", () => {
		assert.equal(supportsOsc9Notification({}), false);
		assert.equal(supportsOsc9Notification({ TERM_PROGRAM: "vscode", TERM: "xterm-256color" }), false);
		assert.equal(supportsOsc9Notification({ WT_SESSION: "abc", TERM_PROGRAM: "Windows Terminal" }), false);
	});
});

describe("isInsideTmux", () => {
	it("detects TMUX env", () => {
		assert.equal(isInsideTmux({ TMUX: "/tmp/tmux-1000/default,1234,0" }), true);
		assert.equal(isInsideTmux({}), false);
	});
});

describe("formatNotification", () => {
	it("joins title and body, stripping control characters", () => {
		assert.equal(formatNotification({ title: "pi", body: "turn complete" }), "pi: turn complete");
		assert.equal(formatNotification({ title: "pi\x1b]9;hack\x07", body: "done\nnow" }), "pi ]9;hack: done now");
	});

	it("truncates to the max message length", () => {
		const long = formatNotification({ title: "x".repeat(500) });
		assert.equal(long.length, 120);
	});

	it("handles empty sides", () => {
		assert.equal(formatNotification({ title: "only title" }), "only title");
		assert.equal(formatNotification({ title: "", body: "only body" }), "only body");
		assert.equal(formatNotification({ title: "" }), "");
	});
});

describe("buildTerminalNotificationSequences", () => {
	it("emits a single OSC 9 sequence for supported terminals", () => {
		assert.deepEqual(buildTerminalNotificationSequences({ title: "pi", body: "done" }, { supportsOsc9: true, insideTmux: false }), [
			`${ESC}]9;pi: done${BEL}`,
		]);
	});

	it("degrades to a bare BEL on unsupported terminals", () => {
		assert.deepEqual(buildTerminalNotificationSequences({ title: "pi" }, { supportsOsc9: false, insideTmux: false }), [BEL]);
		assert.deepEqual(buildTerminalNotificationSequences({ title: "pi" }, { supportsOsc9: false, insideTmux: true }), [BEL]);
	});

	it("wraps OSC 9 in a tmux DCS passthrough with doubled ESC bytes", () => {
		const [sequence] = buildTerminalNotificationSequences({ title: "pi" }, { supportsOsc9: true, insideTmux: true });
		const osc9 = `${ESC}]9;pi${BEL}`;
		const escaped = osc9.replaceAll(ESC, `${ESC}${ESC}`);
		assert.equal(sequence, `${ESC}Ptmux;${escaped}${ESC}\\`);
	});

	it("returns nothing for an empty message", () => {
		assert.deepEqual(buildTerminalNotificationSequences({ title: " \x07 " }, { supportsOsc9: true, insideTmux: false }), []);
	});
});

describe("notifyTerminalOnce", () => {
	const osc9Env = { TERM_PROGRAM: "WezTerm" };

	it("fires once per key and writes the sequences", () => {
		const state = { focused: false, sentKeys: new Set<string>() };
		const first = notifyTerminalOnce({ enabled: true, condition: "always" }, state, "turn-1", { title: "pi" }, osc9Env);
		assert.deepEqual(first, [`${ESC}]9;pi${BEL}`]);
		const second = notifyTerminalOnce({ enabled: true, condition: "always" }, state, "turn-1", { title: "pi" }, osc9Env);
		assert.deepEqual(second, []);
	});

	it("does nothing when disabled", () => {
		const state = { focused: false, sentKeys: new Set<string>() };
		assert.deepEqual(notifyTerminalOnce({ enabled: false, condition: "always" }, state, "k", { title: "pi" }, osc9Env), []);
	});

	it("condition 'unfocused' suppresses while focused but still consumes the key", () => {
		const state = { focused: true, sentKeys: new Set<string>() };
		const suppressed = notifyTerminalOnce({ enabled: true, condition: "unfocused" }, state, "k", { title: "pi" }, osc9Env);
		assert.deepEqual(suppressed, []);
		// kimi semantics: the key is recorded even when focus suppressed the emit
		const again = notifyTerminalOnce({ enabled: true, condition: "unfocused" }, state, "k", { title: "pi" }, osc9Env);
		assert.deepEqual(again, []);
	});

	it("condition 'unfocused' fires while unfocused", () => {
		const state = { focused: false, sentKeys: new Set<string>() };
		const sequences = notifyTerminalOnce({ enabled: true, condition: "unfocused" }, state, "k", { title: "pi" }, osc9Env);
		assert.deepEqual(sequences, [`${ESC}]9;pi${BEL}`]);
	});

	it("falls back to BEL on unsupported terminals", () => {
		const state = { focused: false, sentKeys: new Set<string>() };
		assert.deepEqual(notifyTerminalOnce({ enabled: true, condition: "always" }, state, "k", { title: "pi" }, {}), [BEL]);
	});
});

describe("musepi.notifications settings merge", () => {
	it("applies kimi-style defaults (enabled, unfocused)", async () => {
		const { mergeMusepiSettings } = await import("../src/config/schema.ts");
		assert.deepEqual(mergeMusepiSettings(undefined).notifications, { enabled: true, condition: "unfocused" });
	});

	it("accepts valid overrides and rejects unknown values", async () => {
		const { mergeMusepiSettings } = await import("../src/config/schema.ts");
		assert.deepEqual(mergeMusepiSettings({ notifications: { enabled: false, condition: "always" } }).notifications, {
			enabled: false,
			condition: "always",
		});
		const mistyped = mergeMusepiSettings({
			notifications: { enabled: "yes", condition: "sometimes" } as never,
		}).notifications;
		assert.deepEqual(mistyped, { enabled: true, condition: "unfocused" });
	});
});
