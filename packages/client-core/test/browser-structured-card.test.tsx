import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { setLocale } from "../src/i18n";
import { browserRenderer } from "../src/tool-render/tools/browser";
import type { ToolResultLike } from "../src/tool-render/types";

setLocale("en-US");
const Body = browserRenderer.Body!;

function render(action: string, details: Record<string, unknown>, content: ToolResultLike["content"] = []): string {
	return renderToStaticMarkup(
		createElement(Body, {
			name: "browser",
			args: { action },
			result: { content, details: { action, ...details } },
		}),
	);
}

describe("structured browser cards", () => {
	it("shows real panel state and the controlled/visible tab distinction", () => {
		const html = render("status", {
			status: {
				available: true,
				panelVisible: false,
				activeTabId: "panel-tab-2",
				url: "https://agent.test/",
				title: "Agent page",
				tabs: [
					{
						id: "panel-tab-1",
						title: "User page",
						url: "https://user.test/",
						controlled: false,
						visible: false,
						loading: false,
						canGoBack: true,
						canGoForward: false,
					},
					{
						id: "panel-tab-2",
						title: "Agent page",
						url: "https://agent.test/",
						controlled: true,
						visible: false,
						loading: false,
						canGoBack: false,
						canGoForward: false,
					},
				],
			},
			result: '{"available":true}',
		});
		expect(html).toContain("Browser available");
		expect(html).toContain("Panel visible");
		expect(html).toContain("Controlled tab");
		expect(html).toContain("panel-tab-2");
		expect(html).toContain("User page");
		expect(html).toContain("Agent page");
		expect(html).toContain("2 tabs");
		expect(html).toContain("tv-browser-state-table");
		expect(html).toContain("Raw data");
	});

	it("shows text scope, block counts, truncation, capture time and bounded raw data", () => {
		const html = render("read", {
			pageText: {
				scope: "viewport",
				url: "https://docs.test/",
				title: "Documentation",
				text: "First rendered block",
				blocks: [{ id: "b1", text: "First rendered block" }],
				blockCount: 1,
				totalBlocks: 8,
				truncated: true,
				scanTruncated: false,
				nextCursor: "1:0",
				capturedAt: "2026-11-08T05:33:15.000Z",
			},
			result: '{"scope":"viewport"}',
		});
		expect(html).toContain("Page text");
		expect(html).toContain("Documentation");
		expect(html).toContain("1 block");
		expect(html).toContain("viewport");
		expect(html).toContain("Truncated");
		expect(html).toContain("Scan truncated");
		expect(html).toContain("Captured at");
		expect(html).toContain("2026-11-08T05:33:15.000Z");
		expect(html).toContain("First rendered block");
		expect(html).toContain("tv-browser-text-content");
		expect(html).toContain("Raw data");
	});

	it("shows panel visibility after dedicated panel activation", () => {
		const html = render("activate_panel", {
			control: { action: "activate_panel", panelVisible: true },
			result: '{"action":"activate_panel","panelVisible":true}',
		});
		expect(html).toContain('aria-label="Control"');
		expect(html).toContain("activate_panel");
		expect(html).toContain("Panel visible");
		expect(html).toContain("Yes");
	});

	it("shows navigation action and actual current page", () => {
		const html = render("search", {
			navigation: { action: "search", url: "https://www.bing.com/search?q=hello", title: "hello - Search" },
		});
		expect(html).toContain("Navigation");
		expect(html).toContain("search");
		expect(html).toContain("hello - Search");
		expect(html).toContain("https://www.bing.com/search?q=hello");
	});

	it("shows wait outcome and last observed evidence", () => {
		const html = render("wait_for", {
			waitResult: {
				outcome: "timeout",
				condition: { kind: "text", text: "Done", match: "contains", state: "present" },
				lastObserved: { text: "Loading" },
				timeoutMs: 10000,
			},
		});
		expect(html).toContain("Wait result");
		expect(html).toContain("Timeout");
		expect(html).toContain("Last observed");
		expect(html).toContain("Loading");
	});

	it("shows retained history newest first", () => {
		const html = render("history", {
			history: [
				{ id: "h2", url: "https://example.test/newer", title: "Newer page", visitedAt: 200 },
				{ id: "h1", url: "https://example.test/older", title: "Older page", visitedAt: 100 },
			],
		});
		expect(html).toContain("Browsing history");
		expect(html).toContain("Newer page");
		expect(html).toContain("https://example.test/newer");
		expect(html).toContain("200");
		expect(html.indexOf("Newer page")).toBeLessThan(html.indexOf("Older page"));
	});

	it("shows download status, bytes and optional save path", () => {
		const html = render("downloads", {
			downloads: [
				{
					id: "d1",
					url: "https://example.test/file.zip",
					fileName: "file.zip",
					savePath: "/tmp/file.zip",
					status: "completed",
					receivedBytes: 100,
					totalBytes: 100,
					startedAt: 300,
					endedAt: 400,
				},
			],
		});
		expect(html).toContain("Downloads");
		expect(html).toContain("file.zip");
		expect(html).toContain("completed");
		expect(html).toContain("100 / 100");
		expect(html).toContain("/tmp/file.zip");
	});

	it("shows screenshot metadata beside the actual returned image", () => {
		const html = render(
			"screenshot",
			{
				pageScreenshot: {
					dest: "C:\\shots\\docs.png",
					mimeType: "image/png",
					bytes: 12345,
					width: 800,
					height: 600,
					capturedAt: "2026-11-08T05:35:00.000Z",
				},
				result: "C:\\shots\\docs.png",
			},
			[{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
		);
		expect(html).toContain("Take screenshot");
		expect(html).toContain("800×600");
		expect(html).toContain("12345 bytes");
		expect(html).toContain("Captured at");
		expect(html).toContain("2026-11-08T05:35:00.000Z");
		expect(html).toContain("docs.png");
		expect(html).toContain('src="data:image/png;base64,aW1hZ2U="');
		expect(html).toContain("Raw data");
	});
});
