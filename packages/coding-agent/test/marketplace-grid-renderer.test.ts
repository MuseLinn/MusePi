/**
 * Tests for the marketplace grid renderer.
 *
 * The renderer is pure — every assertion runs on the returned string with no
 * I/O. We cover: empty input, single-column narrow layout, two-column wide
 * layout, description truncation/wrap, version column, marketplace grouping,
 * and the neutral icon fallback when the resolver returns the default.
 */

import { describe, expect, it } from "bun:test";

import { formatPluginGrid } from "@musepi/pi-coding-agent/extensibility/plugins/marketplace/grid-renderer";
import type { MarketplacePluginEntry } from "@musepi/pi-coding-agent/extensibility/plugins/marketplace/types";

function makeEntry(overrides: Partial<MarketplacePluginEntry>): MarketplacePluginEntry {
	return {
		name: "github-mcp",
		source: "./plugins/github-mcp",
		description: "GitHub MCP server — issues, PRs, Actions",
		version: "1.2.0",
		keywords: ["github-mcp"],
		...overrides,
	};
}

describe("formatPluginGrid", () => {
	it("returns a friendly empty-state message", () => {
		expect(formatPluginGrid([])).toBe("No plugins available in configured marketplaces");
	});

	it("renders a header with the plugin count", () => {
		const out = formatPluginGrid([makeEntry({})], { width: 80 });
		expect(out.startsWith("Available plugins (1)")).toBe(true);
	});

	it("includes the resolved icon for an MCP archetype", () => {
		const out = formatPluginGrid([makeEntry({ keywords: ["github-mcp"] })], { width: 80 });
		expect(out).toContain("🐙 github-mcp@1.2.0");
	});

	it("falls back to the neutral 🧩 icon when no archetype matches", () => {
		const out = formatPluginGrid([makeEntry({ name: "obscure-plugin", keywords: [] })], { width: 80 });
		expect(out).toContain("🧩 obscure-plugin@1.2.0");
	});

	it("uses single-column layout when terminal width is below the threshold", () => {
		const entries = [makeEntry({}), makeEntry({ name: "notion-mcp", keywords: ["notion-mcp"] })];
		const out = formatPluginGrid(entries, { width: 60 });
		// Two cards stacked, no side-by-side rows — each header on its own line.
		const headerLines = out.split("\n").filter(line => /^[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(line));
		expect(headerLines.length).toBe(2);
	});

	it("uses two-column layout when terminal width is wide enough", () => {
		const entries = [makeEntry({}), makeEntry({ name: "notion-mcp", keywords: ["notion-mcp"] })];
		const out = formatPluginGrid(entries, { width: 100 });
		// The two header icons appear on the same line, separated by a two-space
		// gutter; the second card occupies the right half of the same row.
		const lines = out.split("\n");
		const headerLine = lines.find(line => line.includes("github-mcp@1.2.0") && line.includes("notion-mcp@1.2.0"));
		expect(headerLine).toBeDefined();
	});

	it("pads the right card with spaces when the row has an odd number of entries", () => {
		const entries = [
			makeEntry({}),
			makeEntry({ name: "notion-mcp", keywords: ["notion-mcp"] }),
			makeEntry({ name: "third-thing", keywords: [] }),
		];
		const out = formatPluginGrid(entries, { width: 100 });
		// Third entry should appear on its own row, indented to the right column.
		const lines = out.split("\n");
		const thirdHeader = lines.find(line => line.includes("🧩 third-thing@1.2.0"));
		expect(thirdHeader).toBeDefined();
		// Trailing whitespace trimmed so the row is at most width characters.
		expect(thirdHeader?.length).toBeLessThanOrEqual(100);
	});

	it("truncates descriptions longer than maxDescriptionLength", () => {
		const entry = makeEntry({
			description: "x".repeat(200),
		});
		const out = formatPluginGrid([entry], { width: 80, maxDescriptionLength: 32 });
		const lines = out.split("\n").filter(line => line.startsWith("    "));
		const descriptionLine = lines.join(" ").trim();
		expect(descriptionLine.length).toBeLessThanOrEqual(33); // 32 + ellipsis char
		expect(descriptionLine.endsWith("…")).toBe(true);
	});

	it("wraps long descriptions onto multiple lines", () => {
		const entry = makeEntry({
			description: "alpha ".repeat(40),
		});
		const out = formatPluginGrid([entry], { width: 40, maxDescriptionLength: 200 });
		const descriptionLines = out.split("\n").filter(line => line.startsWith("    "));
		expect(descriptionLines.length).toBeGreaterThan(1);
	});

	it("omits the description block when the entry has none", () => {
		const entry = makeEntry({ description: undefined });
		const out = formatPluginGrid([entry], { width: 80 });
		const lines = out.split("\n");
		// Header (count) + blank + card header row — no indented description
		// block when the entry lacks one.
		expect(lines.length).toBe(3);
		expect(lines.some(line => line.startsWith("    "))).toBe(false);
	});

	it("groups entries by marketplace when groupByMarketplace is true", () => {
		const entries = [
			makeEntry({ name: "github-mcp@official", keywords: ["github-mcp"] }),
			makeEntry({ name: "notion-mcp@official", keywords: ["notion-mcp"] }),
			makeEntry({ name: "third@community", keywords: [] }),
		];
		const out = formatPluginGrid(entries, { width: 100, groupByMarketplace: true });
		expect(out).toContain("Marketplace: official");
		expect(out).toContain("Marketplace: community");
	});

	it("treats unscoped entries as their own group", () => {
		const entries = [makeEntry({ name: "no-scope", keywords: [] })];
		const out = formatPluginGrid(entries, { width: 80, groupByMarketplace: true });
		expect(out).toContain("Marketplace: (unscoped)");
	});

	it("preserves the version field exactly when present", () => {
		const entry = makeEntry({ version: "0.0.1-rc.4" });
		const out = formatPluginGrid([entry], { width: 80 });
		expect(out).toContain("github-mcp@0.0.1-rc.4");
	});

	it("omits the version suffix when the entry has no version", () => {
		const entry = makeEntry({ version: undefined, keywords: [] });
		const out = formatPluginGrid([entry], { width: 80 });
		expect(out).toContain("🧩 github-mcp");
		expect(out).not.toContain("github-mcp@");
	});
});
