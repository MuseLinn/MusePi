/**
 * `browser.gui` kind resolution: the desktop GUI's managed browser (Electron
 * WebContentsView over a loopback CDP bridge) resolves to a `connected` kind
 * and wins over headless, while explicit app args / relay / cdpUrl settings
 * still take precedence.
 */
import { describe, expect, it } from "bun:test";
import type { BrowserParams } from "@musepi/pi-coding-agent/tools/browser";
import { resolveBrowserKind } from "@musepi/pi-coding-agent/tools/browser";
import type { ToolSession } from "@musepi/pi-coding-agent/tools/index";

function makeSession(settings: Record<string, unknown>): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		settings: { get: (key: string) => settings[key] },
	} as unknown as ToolSession;
}

const noArgs = {} as BrowserParams;
const withApp = (app: BrowserParams["app"]): BrowserParams => ({ action: "open", app }) as BrowserParams;

describe("resolveBrowserKind — GUI managed browser", () => {
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
