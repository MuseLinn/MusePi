/**
 * The composer's auto-size contract.
 *
 * The sizing LOGIC is deliberately not in React: it runs synchronously from
 * six call sites, several of which immediately set the caret or selection —
 * an async spring would break those timings. The spring reaches this
 * textarea as a CSS `linear()` curve instead (sampled from the shared
 * critically damped spring), so the contract to pin here has two halves:
 *
 *   1. the textarea must SHRINK again after it grew. A fast type-then-clear
 *      used to leave the box tall: while a CSS height transition was in
 *      flight, scrollHeight read back the interpolated (still large)
 *      height. The "probe" — turn transitions off, pin height to zero,
 *      then measure — is what prevents that, and it must be preserved.
 *   2. the CSS curve must be CRITICALLY DAMPED. Content growth must not
 *      bounce: a composer that overshoots its height fights the rhythm of
 *      typing. The spring's bounce is zero here, so the sampled `linear()`
 *      stops must be monotonically non-decreasing.
 */
import "./happy-dom-shim";
import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { autosize, MIN_ROWS } from "../src/components/composer-autosize";

const LINE_PX = 20;
const PAD_Y = 16;

afterEach(() => {
	document.body.innerHTML = "";
});

/** A textarea whose scrollHeight follows the number of lines in its value. */
function mockTextarea(): HTMLTextAreaElement {
	const ta = document.createElement("textarea");
	document.body.appendChild(ta);
	let inlineHeight = 0;
	Object.defineProperty(ta, "offsetHeight", {
		configurable: true,
		get: () => inlineHeight,
	});
	// This is the browser behaviour that causes the bug: scrollHeight is
	// max(content, client height). When the box is still TALL (a transition
	// in flight, or just the previous height) and the text has been cleared,
	// a naive read returns the STALE LARGE height instead of the content's.
	Object.defineProperty(ta, "scrollHeight", {
		configurable: true,
		get: () => {
			const content = (ta as HTMLTextAreaElement & { __contentHeight?: number }).__contentHeight ?? 1;
			return Math.max(content, inlineHeight);
		},
	});
	// Only a zero-height probe makes scrollHeight reflect the content alone.
	Object.defineProperty(ta, "style", {
		configurable: true,
		value: new Proxy(ta.style, {
			set(target, prop, value) {
				Reflect.set(target, prop, value);
				if (prop === "height") inlineHeight = Number.parseFloat(String(value)) || 0;
				return true;
			},
		}),
	});
	return ta;
}

function setContentLines(ta: HTMLTextAreaElement, lines: number): void {
	(ta as HTMLTextAreaElement & { __contentHeight?: number }).__contentHeight = lines * LINE_PX + PAD_Y;
}

describe("composer auto-size", () => {
	it("grows with content and shrinks back when the text is cleared", () => {
		const ta = mockTextarea();
		setContentLines(ta, 6);
		autosize(ta);
		const grown = Number.parseFloat(ta.style.height);
		expect(grown).toBeGreaterThanOrEqual(MIN_ROWS * LINE_PX + PAD_Y);

		// The critical case: the box is TALL when the text is cleared. A
		// stale scrollHeight (read from the interpolated height) would say
		// the content is still tall and the box would never shrink.
		setContentLines(ta, 1);
		autosize(ta);
		const shrunk = Number.parseFloat(ta.style.height);
		expect(shrunk).toBeLessThan(grown);
		expect(shrunk).toBe(MIN_ROWS * LINE_PX + PAD_Y);
	});

	it("uses a critically damped curve — the height must never bounce", () => {
		const css = fs.readFileSync(path.join(import.meta.dir, "../src/styles/gui-composer.css"), "utf8");
		const match = css.match(/transition:\s*height\s+180ms\s+linear\(([^)]*)\)/);
		expect(match).not.toBeNull();
		const stops = (match?.[1] ?? "")
			.split(",")
			.map(stop => Number.parseFloat(stop.trim().split(/\s+/)[0] ?? ""))
			.filter(value => Number.isFinite(value));
		expect(stops.length).toBeGreaterThan(4);
		expect(stops[0]).toBe(0);
		expect(stops.at(-1)).toBe(1);
		// Monotonic: no overshoot, no dip. A composer that bounces while
		// you type is a composer you turn off.
		for (let index = 1; index < stops.length; index++) {
			expect(stops[index]!).toBeGreaterThanOrEqual(stops[index - 1]!);
		}
	});
});
