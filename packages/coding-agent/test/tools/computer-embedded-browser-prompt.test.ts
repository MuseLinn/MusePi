/**
 * `computer` prompt — the embedded-browser caveat.
 *
 * Contract: the host app's built-in browser renders inside its own window, so
 * its pages never show up in `desktop.windows()`. On the managed-browser
 * channel the model must be told to use the `browser` tool for those pages;
 * a CLI run (no managed browser) must not get an in-app-browser caveat it
 * cannot act on.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { dropManagedBrowserBridge, setManagedBrowserBridge } from "../../src/tools/browser/managed-bridge";
import { ComputerTool } from "../../src/tools/computer";
import type { ComputerController } from "../../src/tools/computer/supervisor";
import type { ToolSession } from "../../src/tools/index";

const TEST_CONN = "test-computer-prompt-conn";
const CAVEAT = "Embedded browser pages are invisible here";

/**
 * The tool's own supervisor is never started here: the test only reads the
 * rendered description, so a stub controller stands in for it.
 */
function computerTool(settings: Record<string, unknown>): ComputerTool {
	const session = {
		cwd: "/tmp",
		hasUI: false,
		settings: {
			get: (key: string) => settings[key],
			isConfigured: (key: string) => key in settings,
		},
	} as unknown as ToolSession;
	return new ComputerTool(session, () => ({}) as unknown as ComputerController);
}

describe("computer tool description — embedded browser pages", () => {
	afterEach(() => {
		dropManagedBrowserBridge(TEST_CONN);
	});

	it("warns that in-app browser pages are unreachable from the desktop surface", () => {
		setManagedBrowserBridge(TEST_CONN, "http://127.0.0.1:9235");
		expect(computerTool({}).description).toContain(CAVEAT);
	});

	it("stays silent outside the managed-browser channel", () => {
		expect(computerTool({}).description).not.toContain(CAVEAT);
	});
});
