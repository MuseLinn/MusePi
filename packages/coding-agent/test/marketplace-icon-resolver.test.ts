/**
 * Tests for the marketplace icon resolver.
 *
 * Resolution precedence: explicit icon → category → first matching tag/keyword
 * (narrowest match first) → neutral default. Each precedence level has at
 * least one positive case and one fallback-to-next-level case.
 */

import { describe, expect, it } from "bun:test";

import { resolvePluginIcon } from "@musepi/pi-coding-agent/extensibility/plugins/marketplace/icon-resolver";

describe("resolvePluginIcon", () => {
	it("returns the explicit icon when set", () => {
		expect(
			resolvePluginIcon({
				icon: "🛠",
				category: "security",
				tags: ["github"],
				keywords: ["github-mcp"],
			}),
		).toBe("🛠");
	});

	it("strips control characters from explicit icons", () => {
		expect(resolvePluginIcon({ icon: "🛠\u0000\u0007" })).toBe("🛠");
	});

	it("truncates unreasonably long explicit icons", () => {
		const long = "🛠".repeat(100);
		const out = resolvePluginIcon({ icon: long });
		expect(out.endsWith("…")).toBe(true);
		expect(out.length).toBeLessThanOrEqual(9);
	});

	it("preserves file:// and http(s):// icons verbatim (subject to length cap)", () => {
		expect(resolvePluginIcon({ icon: "file:///icons/wrench.svg" })).toBe("file:///icons/wrench.svg");
		expect(resolvePluginIcon({ icon: "https://example.com/icon.svg" })).toBe("https://example.com/icon.svg");
	});

	it("falls back to category lookup", () => {
		expect(resolvePluginIcon({ category: "security" })).toBe("🛡");
		expect(resolvePluginIcon({ category: "testing" })).toBe("🧪");
		expect(resolvePluginIcon({ category: "data" })).toBe("📊");
	});

	it("falls back to keyword lookup (narrow match wins)", () => {
		expect(resolvePluginIcon({ keywords: ["github-mcp"] })).toBe("🐙");
		expect(resolvePluginIcon({ keywords: ["playwright-mcp"] })).toBe("🎭");
		expect(resolvePluginIcon({ tags: ["mcp"] })).toBe("🔌");
	});

	it("falls back to the neutral 🧩 when nothing matches", () => {
		expect(resolvePluginIcon({})).toBe("🧩");
	});

	it("ignores empty / whitespace-only needles", () => {
		expect(resolvePluginIcon({ tags: ["  "], keywords: ["", "  "] })).toBe("🧩");
	});

	it("is case-insensitive on tags and keywords", () => {
		expect(resolvePluginIcon({ tags: ["GITHUB-MCP"] })).toBe("🐙");
		expect(resolvePluginIcon({ keywords: ["Playwright"] })).toBe("🎭");
	});

	it("prefers category over tags when both match", () => {
		// Category "testing" → 🧪 should beat tag "github" → 🐙.
		expect(resolvePluginIcon({ category: "testing", tags: ["github"] })).toBe("🧪");
	});
});
