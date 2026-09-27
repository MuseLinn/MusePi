/**
 * `browser.gui` kind resolution: the desktop GUI's managed browser (Electron
 * WebContentsView over a loopback CDP bridge) resolves to a `connected` kind
 * and wins over headless, while explicit app args / relay / cdpUrl settings
 * still take precedence.
 *
 * Desktop-host default: the GUI pushes the bridge's ACTUAL port over RPC
 * (`browser.managedBridge`), and an UNCONFIGURED `browser.gui` then defaults
 * to the managed browser — the agent's pages are visible in the side panel
 * instead of running in an invisible headless Chromium. A user who set the
 * setting explicitly (including `false`) always wins.
 */
import { afterEach, describe, expect, it } from "bun:test";
import type { BrowserParams } from "@musepi/pi-coding-agent/tools/browser";
import { BrowserTool, resolveBrowserKind } from "@musepi/pi-coding-agent/tools/browser";
import {
	dropManagedBrowserBridge,
	setManagedBrowserBridge,
} from "@musepi/pi-coding-agent/tools/browser/managed-bridge";
import type { ToolSession } from "@musepi/pi-coding-agent/tools/index";

const TEST_CONN = "test-bridge-conn";

function makeSession(settings: Record<string, unknown>): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		settings: {
			get: (key: string) => settings[key],
			isConfigured: (key: string) => key in settings,
		},
	} as unknown as ToolSession;
}

const noArgs = {} as BrowserParams;
const withApp = (app: BrowserParams["app"]): BrowserParams => ({ action: "open", app }) as BrowserParams;

describe("resolveBrowserKind — GUI managed browser", () => {
	afterEach(() => {
		dropManagedBrowserBridge(TEST_CONN);
	});

	it("resolves to connected guiUrl when browser.gui is enabled", () => {
		const kind = resolveBrowserKind(
			noArgs,
			makeSession({ "browser.gui": true, "browser.guiUrl": "http://127.0.0.1:9230" }),
		);
		expect(kind).toEqual({ kind: "connected", cdpUrl: "http://127.0.0.1:9230", gui: true });
	});

	it("trailing slashes on guiUrl are trimmed", () => {
		const kind = resolveBrowserKind(
			noArgs,
			makeSession({ "browser.gui": true, "browser.guiUrl": "http://127.0.0.1:9230/" }),
		);
		expect(kind).toEqual({ kind: "connected", cdpUrl: "http://127.0.0.1:9230", gui: true });
	});

	it("falls back to headless when browser.gui is disabled", () => {
		const kind = resolveBrowserKind(
			noArgs,
			makeSession({ "browser.gui": false, "browser.guiUrl": "http://127.0.0.1:9230", "browser.headless": true }),
		);
		expect(kind).toEqual({ kind: "headless", headless: true });
	});

	it("falls back to headless when browser.gui is enabled but guiUrl is empty", () => {
		const kind = resolveBrowserKind(
			noArgs,
			makeSession({ "browser.gui": true, "browser.guiUrl": "   ", "browser.headless": false }),
		);
		expect(kind).toEqual({ kind: "headless", headless: false });
	});

	it("explicit app.cdp_url still wins over browser.gui", () => {
		const kind = resolveBrowserKind(
			withApp({ cdp_url: "http://127.0.0.1:9222" }),
			makeSession({ "browser.gui": true, "browser.guiUrl": "http://127.0.0.1:9230" }),
		);
		expect(kind).toEqual({ kind: "connected", cdpUrl: "http://127.0.0.1:9222" });
	});

	it("explicit app.relay still wins over browser.gui", () => {
		const kind = resolveBrowserKind(
			withApp({ relay: true }),
			makeSession({ "browser.gui": true, "browser.guiUrl": "http://127.0.0.1:9230" }),
		);
		expect(kind.kind).toBe("relay");
	});

	it("browser.relay setting still wins over browser.gui", () => {
		const kind = resolveBrowserKind(
			noArgs,
			makeSession({
				"browser.gui": true,
				"browser.guiUrl": "http://127.0.0.1:9230",
				"browser.relay": true,
				"browser.relayUrl": "http://127.0.0.1:9224",
			}),
		);
		expect(kind).toEqual({ kind: "relay", cdpUrl: "http://127.0.0.1:9224" });
	});

	it("configured browser.cdpUrl still wins over browser.gui", () => {
		const kind = resolveBrowserKind(
			noArgs,
			makeSession({
				"browser.gui": true,
				"browser.guiUrl": "http://127.0.0.1:9230",
				"browser.cdpUrl": "http://127.0.0.1:9222",
			}),
		);
		expect(kind).toEqual({ kind: "connected", cdpUrl: "http://127.0.0.1:9222" });
	});
});

// ── Desktop-host default: the live bridge decides an UNCONFIGURED setting ──
//
// Contract: in a daemon driven by the desktop app, the agent's browser tool
// must land in the app's own browser (the user sees every page). Regression
// would be the old behavior — a headless Chromium nobody can see — and, at
// the other end, a default that overrides a user who turned it off.
describe("resolveBrowserKind — desktop-host default", () => {
	afterEach(() => {
		dropManagedBrowserBridge(TEST_CONN);
	});

	it("an unconfigured browser.gui takes over the managed browser while the desktop bridge is up", () => {
		setManagedBrowserBridge(TEST_CONN, "http://127.0.0.1:9235");
		const kind = resolveBrowserKind(noArgs, makeSession({ "browser.headless": true }));
		expect(kind).toEqual({ kind: "connected", cdpUrl: "http://127.0.0.1:9235", gui: true });
	});

	it("the live bridge's actual port beats the guiUrl default (9230-9239 is a retry range)", () => {
		setManagedBrowserBridge(TEST_CONN, "http://127.0.0.1:9237");
		const kind = resolveBrowserKind(
			noArgs,
			makeSession({ "browser.guiUrl": "http://127.0.0.1:9230", "browser.headless": true }),
		);
		expect(kind).toEqual({ kind: "connected", cdpUrl: "http://127.0.0.1:9237", gui: true });
	});

	it("an explicit browser.gui=false is honored even while the bridge is up", () => {
		setManagedBrowserBridge(TEST_CONN, "http://127.0.0.1:9235");
		const kind = resolveBrowserKind(
			noArgs,
			makeSession({ "browser.gui": false, "browser.guiUrl": "http://127.0.0.1:9230", "browser.headless": true }),
		);
		expect(kind).toEqual({ kind: "headless", headless: true });
	});

	it("an explicit browser.gui=true still targets the configured url when no bridge is up", () => {
		const kind = resolveBrowserKind(
			noArgs,
			makeSession({ "browser.gui": true, "browser.guiUrl": "http://127.0.0.1:9230" }),
		);
		expect(kind).toEqual({ kind: "connected", cdpUrl: "http://127.0.0.1:9230", gui: true });
	});

	it("falls back to headless once the desktop GUI disconnects (bridge withdrawn)", () => {
		setManagedBrowserBridge(TEST_CONN, "http://127.0.0.1:9235");
		dropManagedBrowserBridge(TEST_CONN);
		const kind = resolveBrowserKind(noArgs, makeSession({ "browser.headless": true }));
		expect(kind).toEqual({ kind: "headless", headless: true });
	});
});

// ── Prompt injection: the managed-browser paragraph rides only its channel ──
//
// Contract: on the managed channel the model is told its pages are visible in
// the app panel (and invisible to `computer`); a CLI run must never see it.
describe("browser tool description — managed browser channel", () => {
	afterEach(() => {
		dropManagedBrowserBridge(TEST_CONN);
	});

	it("tells the model about the visible in-app browser when the channel is active", () => {
		setManagedBrowserBridge(TEST_CONN, "http://127.0.0.1:9235");
		const tool = new BrowserTool(makeSession({}));
		expect(tool.description).toContain("Managed browser channel");
	});

	it("leaves the CLI/headless prompt untouched when the channel is off", () => {
		const tool = new BrowserTool(makeSession({}));
		expect(tool.description).not.toContain("Managed browser channel");
	});

	it("keeps the channel paragraph out of the prompt even when the user disabled it explicitly", () => {
		setManagedBrowserBridge(TEST_CONN, "http://127.0.0.1:9235");
		const tool = new BrowserTool(makeSession({ "browser.gui": false }));
		expect(tool.description).not.toContain("Managed browser channel");
	});
});
