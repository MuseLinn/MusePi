import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Shell interaction contracts that only CSS can express.
 *
 * bun has no CSS engine, so these pin the rules themselves, the same way
 * `brand-accent.test.ts` pins palette literals: the alternative is a contract
 * that silently stops holding when someone edits one selector.
 *
 * Two contracts:
 *   1. A control that reveals its state on `:hover` must reveal it on
 *      `:focus-visible` too — keyboard users get the same affordance, and
 *      base.css deliberately draws no global focus ring. `:focus-within` is
 *      forbidden for this: a pointer click leaves focus in the row, so the
 *      strip would stay lit after the pointer leaves.
 *   2. Every touch-sized control in the shell must reach the coarse-pointer
 *      floor (48px, HarmonyOS @cross-device-app-dev/touch-target-size).
 */

const CSS = fs.readFileSync(path.resolve(import.meta.dir, "../src/components/shell/shell.css"), "utf8");

/** Comments name the old behaviour, so they must not satisfy an assertion. */
const stripComments = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, "");

/** The declaration block of the first rule whose selector list contains `selector`. */
function ruleFor(css: string, selector: string): string | null {
	const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = new RegExp(`(^|\\n)\\s*[^{}]*${escaped}[^{}]*\\{([^}]*)\\}`).exec(css);
	return match ? match[2]! : null;
}

describe("hover affordances are reachable from the keyboard", () => {
	const rows = [
		".sh-ws-side-item",
		".sh-ws-group-head",
		".sh-ws-sidebar-toggle",
		".sh-ws-action-btn",
		".sh-queue-row-actions button",
		".sh-queue-actions button",
		".sh-connect-recent-rm",
		".sh-toast-close",
	];

	for (const selector of rows) {
		test(`${selector} pairs :hover with :focus-visible`, () => {
			const css = stripComments(CSS);
			const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			// Every rule that mentions this selector's hover state must also
			// name focus-visible in the same selector list.
			const hoverRules = css.match(new RegExp(`[^{}]*${escaped}[^{}]*:hover[^{}]*\\{[^}]*\\}`, "g")) ?? [];
			expect(hoverRules.length).toBeGreaterThan(0);
			for (const rule of hoverRules) {
				expect(rule, `${selector}: hover has no focus-visible partner -> ${rule}`).toContain(":focus-visible");
			}
		});
	}

	test("no shell rule reveals state through :focus-within", () => {
		// A pointer click leaves focus inside the row, so a focus-within reveal
		// stays lit after the pointer leaves. The one allowed use is the
		// composer frame, which is a container highlight rather than a
		// reveal of otherwise hidden controls.
		const offenders = stripComments(CSS)
			.split("\n")
			.filter(line => line.includes(":focus-within") && !line.includes(".sh-composer-inner"));
		expect(offenders).toEqual([]);
	});
});

describe("touch targets reach the coarse-pointer floor", () => {
	const floor = ruleFor(
		stripComments(CSS).slice(stripComments(CSS).indexOf("@media (pointer: coarse)")),
		"sh-ws-side-item",
	);
	const block = stripComments(CSS).slice(stripComments(CSS).indexOf("@media (pointer: coarse)"));

	test("the rail's row controls and the queue's row actions are inside it", () => {
		expect(floor).not.toBeNull();
		for (const selector of [
			".sh-ws-side-item",
			".sh-ws-group-head",
			".sh-ws-sidebar-toggle",
			".sh-queue-row-actions button",
			".sh-queue-actions button",
			".ss-swipe-btn",
		]) {
			// The selector has to be named inside the coarse-pointer block; the
			// declarations themselves are checked by the next test.
			expect(block, `${selector} missing from the coarse-pointer floor`).toContain(selector);
		}
	});

	test("those controls get both axes, not just height", () => {
		// A 26px icon button lifted to 48px tall but left narrow is still a
		// miss on the width axis, so the width has to be declared somewhere in
		// the coarse-pointer block for this selector.
		const rules = block.match(/[^{}]*\.sh-ws-sidebar-toggle[^{}]*\{[^}]*\}/g) ?? [];
		expect(rules.length).toBeGreaterThan(0);
		expect(rules.join("\n")).toContain("min-width: 48px");
	});
});

describe("press feedback and motion preferences", () => {
	test("icon controls smaller than a fingertip give press feedback", () => {
		const css = stripComments(CSS);
		for (const selector of [".sh-ws-action-btn", ".sh-ws-sidebar-toggle"]) {
			const active =
				css.match(new RegExp(`[^{}]*${selector.replace(/\./g, "\\.")}:active[^{}]*\\{[^}]*\\}`, "g")) ?? [];
			expect(active.length, `${selector} has no :active feedback`).toBeGreaterThan(0);
		}
	});

	test("the press-scale transform is disabled under reduced motion", () => {
		// The scale is decorative; a user who asked for less motion keeps the
		// colour change but not the geometry change. Assert the DECLARATION —
		// the selectors also appear in transition lists, which proves nothing.
		const reduced = stripComments(CSS).split("@media (prefers-reduced-motion: reduce)");
		const tail = reduced.slice(1).join("\n@media (prefers-reduced-motion: reduce)");
		for (const selector of [".sh-ws-action-btn:active", ".sh-ws-sidebar-toggle:active"]) {
			const rules = tail.match(
				new RegExp(`[^{}]*${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^{}]*\\{[^}]*\\}`, "g"),
			);
			expect(rules, `${selector} not reset under reduced motion`).not.toBeNull();
			expect(rules!.join("\n")).toContain("transform: none");
		}
	});
});
