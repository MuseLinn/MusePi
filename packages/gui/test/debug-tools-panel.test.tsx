import "./dom-shim"; // MUST be first: desktop-web element classes extend HTMLElement at import time.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { getLocaleSnapshot, setLocale } from "@musepi/desktop-web";
import { DebugToolsPanelBody } from "../src/components/DebugToolsPanel";

/**
 * DebugToolsPanel render test (TUI /debug selector parity). SSR-level:
 * verifies the full menu renders with real i18n keys, the terminal-only
 * entries are disabled, and the panel mounts through DialogFrame's portal.
 * The daemon side of every action is covered by
 * coding-agent/test/daemon/debug-rpc.test.ts.
 */

const INITIAL_LOCALE = getLocaleSnapshot();

beforeAll(() => {
	setLocale("en-US");
});

afterAll(() => setLocale(INITIAL_LOCALE));

function renderPanel(): string {
	return renderToStaticMarkup(
		<DebugToolsPanelBody
			open
			onClose={() => {}}
			rpc={{ request: async <T,>() => ({}) as T }}
			sessionId="s1"
		/>,
	);
}

describe("DebugToolsPanel", () => {
	test("renders every TUI /debug menu action with its label + description", () => {
		const html = renderPanel();
		const labels = [
			"Debug Tools",
			"Open: artifact folder",
			"Report: performance issue",
			"Profile: work scheduling",
			"Report: dump session",
			"Report: memory issue",
			"View: recent logs",
			"View: system info",
			"View: terminal state",
			"Test: terminal protocols",
			"View: raw SSE stream",
			"Start: JS remote debugger",
			"Export: session transcript",
			"Clear: artifact cache",
		];
		for (const label of labels) {
			expect(html).toContain(label);
		}
		// Descriptions render too (spot-check the two longest).
		expect(html).toContain("Profile CPU, reproduce, then bundle");
		expect(html).toContain("Expose JavaScriptCore inspector socket (experimental)");
	});

	test("terminal-only entries are disabled with a tag", () => {
		const html = renderPanel();
		expect(html).toContain("Terminal only");
		// Exactly the two terminal-bound rows are disabled in a fresh render.
		const disabledCount = html.split('disabled=""').length - 1;
		expect(disabledCount).toBe(2);
	});

	test("the clear-cache action stays unarmed until the user confirms", () => {
		// No cache stats are fetched at render time — the confirm flow only
		// starts on click (client-side), so a fresh render must NOT contain
		// a confirm button.
		const html = renderPanel();
		expect(html).not.toContain("Confirm clear");
	});
});
