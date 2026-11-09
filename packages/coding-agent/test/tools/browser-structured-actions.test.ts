import { describe, expect, it } from "bun:test";
import { toolWireSchema, validateJsonSchemaValue } from "@musepi/pi-ai/utils/schema";
import { Settings } from "@musepi/pi-coding-agent/config/settings";
import type { ToolSession } from "@musepi/pi-coding-agent/sdk";
import { BrowserTool } from "@musepi/pi-coding-agent/tools/browser";
import { browserStatusFromTabs, readManagedBrowserStatus } from "@musepi/pi-coding-agent/tools/browser/state";

function makeSession(): ToolSession {
	return {
		cwd: "/tmp/test",
		hasUI: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
	};
}

describe("structured browser action schema", () => {
	it("accepts status, bounded read and screenshot variants", () => {
		const schema = toolWireSchema(new BrowserTool(makeSession()));
		expect(validateJsonSchemaValue(schema, { action: "status" }).success).toBe(true);
		expect(
			validateJsonSchemaValue(schema, {
				action: "read",
				name: "docs",
				scope: "document",
				maxChars: 12000,
				cursor: "0:120",
			}).success,
		).toBe(true);
		expect(validateJsonSchemaValue(schema, { action: "screenshot", name: "docs", fullPage: true }).success).toBe(
			true,
		);
	});
});

describe("browser status projection", () => {
	it("reads the managed panel's actual control and visible tab state", async () => {
		const fixture = {
			available: true,
			panelVisible: true,
			activeTabId: "panel-tab-2",
			visibleTabId: "panel-tab-1",
			url: "https://example.test/current",
			title: "Current",
			tabs: [
				{
					id: "panel-tab-1",
					title: "User tab",
					url: "https://example.test/",
					controlled: false,
					visible: true,
					loading: false,
					canGoBack: true,
					canGoForward: false,
				},
				{
					id: "panel-tab-2",
					title: "Agent tab",
					url: "https://example.test/current",
					controlled: true,
					visible: false,
					loading: false,
					canGoBack: false,
					canGoForward: false,
				},
			],
		};
		const server = Bun.serve({
			port: 0,
			fetch: request => {
				expect(new URL(request.url).pathname).toBe("/musepi/state");
				return Response.json(fixture);
			},
		});
		try {
			const status = await readManagedBrowserStatus(`http://127.0.0.1:${server.port}`);
			expect(status).toEqual(fixture);
			expect(status.activeTabId).not.toBe(status.visibleTabId);
		} finally {
			server.stop(true);
		}
	});

	it("projects only known supervised-tab facts outside the GUI", () => {
		const status = browserStatusFromTabs([
			{
				name: "docs",
				targetId: "PAGE1",
				state: "alive",
				info: { url: "https://example.test", title: "Docs" },
			},
		]);
		expect(status).toEqual({
			available: true,
			tabs: [{ id: "PAGE1", title: "Docs", url: "https://example.test", controlled: true }],
		});
		expect(status.activeTabId).toBeUndefined();
		expect(status.panelVisible).toBeUndefined();
		expect(status.visibleTabId).toBeUndefined();
	});

	it("keeps an unopened non-GUI backend available without inventing an active tab", () => {
		expect(browserStatusFromTabs([])).toEqual({ available: true, tabs: [] });
	});
});

describe("structured browser prompt", () => {
	it("teaches state discovery, cursor continuation and the text/element distinction", () => {
		const description = new BrowserTool(makeSession()).description;
		expect(description).toContain('action:"status"');
		expect(description).toContain('action:"read"');
		expect(description).toContain("nextCursor");
		expect(description).toContain("Text block ids are not element refs");
		expect(description).toContain('action:"screenshot"');
	});
});
