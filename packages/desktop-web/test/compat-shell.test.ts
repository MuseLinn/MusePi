/**
 * `?shell=1` protocol: the Electron compat shell loads the served renderer
 * with the query flag, and the page reserves the 48px titlebar region in
 * response (frame overlay). Tests the exact-parse boundary the shell and the
 * renderer agree on — `shell` must equal `"1"`, not merely be present.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { isCompatShell } from "../src/lib/compat-shell";

const originalWindow = globalThis.window;

function withSearch(search: string, fn: () => boolean): boolean {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	(globalThis as any).window = { location: { search } };
	try {
		return fn();
	} finally {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(globalThis as any).window = originalWindow;
	}
}

afterEach(() => {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	(globalThis as any).window = originalWindow;
});

describe("isCompatShell (?shell=1 frame-overlay contract)", () => {
	it("true for the exact shell flag", () => {
		expect(withSearch("?shell=1", isCompatShell)).toBe(true);
	});

	it("false when the flag is absent", () => {
		expect(withSearch("", isCompatShell)).toBe(false);
		expect(withSearch("?other=1", isCompatShell)).toBe(false);
	});

	it("false for a different value (exact match, not prefix)", () => {
		expect(withSearch("?shell=0", isCompatShell)).toBe(false);
		expect(withSearch("?shell=10", isCompatShell)).toBe(false);
	});
});
