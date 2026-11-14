import { describe, expect, test } from "bun:test";
import { escapeOwner, shouldEscapeStopTurn } from "../src/lib/escape-stop";

/**
 * Bare-Escape interrupt gating. Regression: the window-level Escape binding
 * called `session.abort` unconditionally, so any Escape that reached the
 * window (a menu dismissal whose handler did not claim the key, a held key,
 * a field's own Escape, another window's probe) ended the running turn as
 * "Interrupted by user". The gate keeps TUI parity (bare Escape while the
 * agent works) and drops every Escape another surface owns.
 */
const idle = { claimed: false, owner: null, repeat: false, working: true } as const;

describe("shouldEscapeStopTurn", () => {
	test("interrupts on a bare Escape while a turn runs", () => {
		expect(shouldEscapeStopTurn(idle)).toBe(true);
	});

	test("never interrupts when no turn is running", () => {
		// Aborting an idle session still stamps it user-interrupted, which
		// latches advisor auto-resume suppression until the next prompt.
		expect(shouldEscapeStopTurn({ ...idle, working: false })).toBe(false);
	});

	test("defers to a surface that claimed the key", () => {
		expect(shouldEscapeStopTurn({ ...idle, claimed: true })).toBe(false);
	});

	test("ignores key repeat from a held Escape", () => {
		expect(shouldEscapeStopTurn({ ...idle, repeat: true })).toBe(false);
	});

	test("leaves Escape to an open dialog, menu or listbox", () => {
		expect(shouldEscapeStopTurn({ ...idle, owner: "overlay" })).toBe(false);
	});

	test("leaves Escape to a field that owns it (search, rename, address bar)", () => {
		expect(shouldEscapeStopTurn({ ...idle, owner: "field" })).toBe(false);
	});
});

/**
 * Owner resolution walks the ancestor chain through `closest`. The test
 * supplies a stub element whose `closest` implements the selector forms the
 * module uses (tag name, [attr], [attr="value"], comma lists) — the DOM's own
 * matching is not this module's code, the selector choice is.
 */
type StubEl = {
	closest(selector: string): StubEl | null;
};

function el(tag: string, attrs: Record<string, string> = {}, parent: StubEl | null = null): StubEl {
	const node: StubEl = {
		closest(selector: string): StubEl | null {
			for (const part of selector.split(",").map(s => s.trim())) {
				const attrEq = /^\[([\w-]+)="([^"]*)"\]$/.exec(part);
				const attr = /^\[([\w-]+)\]$/.exec(part);
				const self = attrEq ? attrs[attrEq[1]!] === attrEq[2] : attr ? attr[1]! in attrs : tag === part;
				if (self) return node;
			}
			return parent?.closest(selector) ?? null;
		},
	};
	return node;
}

describe("escapeOwner", () => {
	test("a control inside the chat composer keeps interrupt semantics", () => {
		const composer = el("div", { "data-chat-input": "true" });
		expect(escapeOwner(el("textarea", {}, composer) as unknown as EventTarget)).toBe(null);
	});

	test("a control in any other field owns Escape", () => {
		expect(escapeOwner(el("input") as unknown as EventTarget)).toBe("field");
	});

	test("an open dialog outranks a field inside it", () => {
		const dialog = el("div", { role: "dialog" });
		expect(escapeOwner(el("input", {}, dialog) as unknown as EventTarget)).toBe("overlay");
	});

	test("a plain element owns nothing", () => {
		expect(escapeOwner(el("span") as unknown as EventTarget)).toBe(null);
	});

	test("a target with no closest (window/document) owns nothing", () => {
		expect(escapeOwner(null)).toBe(null);
		expect(escapeOwner({} as unknown as EventTarget)).toBe(null);
	});
});
