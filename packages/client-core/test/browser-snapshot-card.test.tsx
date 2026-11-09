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

describe("browser snapshot cards", () => {
	it("shows element refs, scope, counts and continuation", () => {
		const html = render("elements", {
			elementsSnapshot: {
				snapshotId: "elements-42",
				scope: "viewport",
				url: "https://example.test",
				title: "Example",
				elements: [{ ref: "e7", role: "button", name: "Submit", states: ["focusable"] }],
				returned: 1,
				total: 12,
				truncated: true,
				scanTruncated: false,
				nextCursor: "1",
				capturedAt: "2026-11-08T06:00:00.000Z",
			},
		});
		expect(html).toContain("Element snapshot");
		expect(html).toContain("elements-42");
		expect(html).toContain("e7");
		expect(html).toContain("Submit");
		expect(html).toContain("focusable");
		expect(html).toContain("1 / 12");
		expect(html).toContain("Next cursor");
	});

	it("shows visual snapshot identity and coordinate mapping beside the image", () => {
		const html = render(
			"visual",
			{
				visualSnapshot: {
					snapshotId: "visual-42",
					url: "https://example.test",
					title: "Example",
					viewport: { width: 1100, height: 750 },
					image: { dest: "shot.png", mimeType: "image/png", bytes: 100, width: 1024, height: 696 },
					capturedAt: "2026-11-08T06:00:00.000Z",
				},
			},
			[{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
		);
		expect(html).toContain("Visual snapshot");
		expect(html).toContain("visual-42");
		expect(html).toContain("1024×696");
		expect(html).toContain("1100×750");
		expect(html).toContain("Screenshot pixels");
		expect(html).toContain('src="data:image/png;base64,aW1hZ2U="');
	});

	it("shows the source and region of an original-image crop", () => {
		const html = render(
			"visual_crop",
			{
				visualCrop: {
					sourceSnapshotId: "visual-42",
					region: { x: 10, y: 20, width: 30, height: 40 },
					image: { dest: "crop.png", mimeType: "image/png", bytes: 100, width: 30, height: 40 },
					capturedAt: "2026-11-08T06:00:00.000Z",
				},
			},
			[{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
		);
		expect(html).toContain("Visual crop");
		expect(html).toContain("visual-42");
		expect(html).toContain("30×40");
		expect(html).toContain("10, 20");
		expect(html).toContain('src="data:image/png;base64,aW1hZ2U="');
	});

	it("shows the device profile catalog", () => {
		const html = render("device_profiles", {
			deviceProfiles: [{ id: "iphone-14-pro", width: 393, height: 852, mobile: true, touch: true }],
		});
		expect(html).toContain("Device profiles");
		expect(html).toContain("iphone-14-pro");
		expect(html).toContain("393×852");
	});

	it("shows responsive viewport, orientation and display scale separately", () => {
		const html = render("set_device", {
			deviceConfiguration: {
				enabled: true,
				profileId: "responsive",
				orientation: "landscape",
				scaleMode: "fixed",
				scale: 0.5,
				viewport: { width: 800, height: 400, isMobile: true, hasTouch: true, isLandscape: true },
			},
		});
		expect(html).toContain("Device configuration");
		expect(html).toContain("responsive");
		expect(html).toContain("800×400");
		expect(html).toContain("Landscape");
		expect(html).toContain("50%");
	});

	it("shows nearby candidates without claiming a click", () => {
		const html = render("click_if_interactive", {
			visualInteraction: {
				outcome: "candidates",
				candidates: [{ x: 120, y: 240, role: "button", name: "Submit", distance: 20 }],
			},
		});
		expect(html).toContain("Candidates");
		expect(html).toContain("Submit");
		expect(html).toContain("No click performed");
	});

	it("shows an exact interactive click as a completed action with its target", () => {
		const html = render("click_if_interactive", {
			visualInteraction: {
				outcome: "clicked",
				target: { x: 120, y: 240, role: "button", name: "Submit" },
			},
		});
		expect(html).toContain("Action receipt");
		expect(html).toContain("Completed");
		expect(html).toContain("Submit");
		expect(html).toContain("button");
		expect(html).not.toContain("No click performed");
	});

	it("shows failed action receipts without presenting them as successful", () => {
		const html = render("click", {
			actionReceipt: {
				action: "click",
				status: "failed",
				target: "e99",
				url: "https://example.test",
				error: "Element snapshot expired",
			},
		});
		expect(html).toContain("Action receipt");
		expect(html).toContain("Failed");
		expect(html).toContain("e99");
		expect(html).toContain("Element snapshot expired");
		expect(html).toContain("tv-browser-receipt--failed");
	});
});
