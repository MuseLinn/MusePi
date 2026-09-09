import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MarketplaceCard } from "../src/components/marketplace/MarketplaceCard";
import { MarketplaceGrid } from "../src/components/marketplace/MarketplaceGrid";
import { type MarketplaceCardEntry, resolveCardIcon } from "../src/components/marketplace/types";

/** Build a minimal entry with sensible defaults; tests override only fields
 *  they care about so the suite stays readable. */
function makeEntry(over: Partial<MarketplaceCardEntry> = {}): MarketplaceCardEntry {
	return {
		name: "github-mcp",
		description: "Talk to GitHub from your agent.",
		author: "Anthropic",
		version: "1.2.3",
		marketplace: "anthropic-official",
		installs: 12345,
		...over,
	};
}

describe("resolveCardIcon", () => {
	it("uses the explicit icon when supplied", () => {
		expect(resolveCardIcon({ name: "x", icon: "🛠" })).toBe("🛠");
	});

	it("strips control characters from the explicit icon", () => {
		expect(resolveCardIcon({ name: "x", icon: "🛠\u0007\u0000" })).toBe("🛠");
	});

	it("caps the explicit icon length", () => {
		expect(resolveCardIcon({ name: "x", icon: "abcdefghijklmnop" }).length).toBe(8);
	});

	it("preserves short URIs verbatim", () => {
		// The 8-char cap is for emoji/glyph abuse, not real URIs. Short
		// file:// and https:// icons come back untouched; long ones get
		// truncated just like any other over-long icon.
		expect(resolveCardIcon({ name: "x", icon: "file://x" })).toBe("file://x");
	});

	it("truncates URIs longer than the 8-char glyph cap", () => {
		const truncated = resolveCardIcon({ name: "x", icon: "https://example.com/long.png" });
		expect(truncated.length).toBe(8);
	});

	it("falls back to category table", () => {
		expect(resolveCardIcon({ name: "x", category: "security" })).toBe("🛡️");
		expect(resolveCardIcon({ name: "x", category: "ai" })).toBe("🧠");
	});

	it("falls back to keyword scan when no category match", () => {
		expect(resolveCardIcon({ name: "playwright-mcp" })).toBe("🎭");
		expect(resolveCardIcon({ name: "docker-tool" })).toBe("🐳");
		expect(resolveCardIcon({ name: "github-mcp" })).toBe("🐙");
	});

	it("falls back to neutral when nothing matches", () => {
		expect(resolveCardIcon({ name: "x" })).toBe("🧩");
	});

	it("ignores empty needles", () => {
		expect(resolveCardIcon({ name: "x" })).toBe("🧩");
		expect(resolveCardIcon({ name: "" })).toBe("🧩");
	});

	it("category wins over keyword (category lookup is narrower)", () => {
		// 'aws' would match the aws keyword icon, but the category explicitly
		// takes precedence — so security category must surface the shield.
		expect(resolveCardIcon({ name: "aws", category: "security" })).toBe("🛡️");
	});
});

describe("MarketplaceCard", () => {
	it("renders the resolved icon and the name", () => {
		const html = renderToStaticMarkup(<MarketplaceCard entry={makeEntry()} />);
		expect(html).toContain("🐙");
		expect(html).toContain("github-mcp");
	});

	it("renders the version stamp with the v-prefix", () => {
		const html = renderToStaticMarkup(<MarketplaceCard entry={makeEntry()} />);
		expect(html).toContain("v1.2.3");
	});

	it("omits the version when absent", () => {
		const html = renderToStaticMarkup(<MarketplaceCard entry={makeEntry({ version: undefined })} />);
		expect(html).not.toContain("v1.2.3");
	});

	it("renders the description when present", () => {
		const html = renderToStaticMarkup(<MarketplaceCard entry={makeEntry()} />);
		expect(html).toContain("Talk to GitHub from your agent.");
	});

	it("renders short install counts (under 1000) verbatim", () => {
		const html = renderToStaticMarkup(<MarketplaceCard entry={makeEntry({ installs: 742 })} />);
		expect(html).toContain("↓ 742");
	});

	it("renders thousand-suffix counts in the compact form", () => {
		// 5-digit counts (≥10k) drop the decimal to keep the chip narrow;
		// 4-digit counts (≥1k, <10k) keep one decimal so 1_234 → 1.2k.
		const html1 = renderToStaticMarkup(<MarketplaceCard entry={makeEntry({ installs: 1_234 })} />);
		expect(html1).toContain("↓ 1.2k");
		const html2 = renderToStaticMarkup(<MarketplaceCard entry={makeEntry({ installs: 12_300 })} />);
		expect(html2).toContain("↓ 12k");
	});

	it("renders million-suffix counts in the compact form", () => {
		const html = renderToStaticMarkup(<MarketplaceCard entry={makeEntry({ installs: 2_500_000 })} />);
		expect(html).toContain("↓ 2.5M");
	});

	it("renders the author and category chips", () => {
		const html = renderToStaticMarkup(<MarketplaceCard entry={makeEntry({ category: "ai" })} />);
		expect(html).toContain("by Anthropic");
		expect(html).toContain(">ai<");
	});

	it("shows the install button by default when not installed", () => {
		const html = renderToStaticMarkup(<MarketplaceCard entry={makeEntry()} />);
		// Buttons carry the localized label via t(); we assert on the
		// distinguishing class instead of the literal string so the test
		// survives locale changes.
		expect(html).toContain("mp-btn--accent");
		expect(html).not.toContain("mp-btn--warn");
	});

	it("shows the remove button instead when installed", () => {
		const html = renderToStaticMarkup(<MarketplaceCard entry={makeEntry({ installed: true })} />);
		expect(html).toContain("mp-btn--warn");
		expect(html).not.toContain("mp-btn--accent");
	});

	it("marks the card as installed with the accent border class", () => {
		const html = renderToStaticMarkup(<MarketplaceCard entry={makeEntry({ installed: true })} />);
		expect(html).toContain("mp-card--installed");
	});

	it("disables the buttons while busy and marks the card busy", () => {
		const html = renderToStaticMarkup(<MarketplaceCard entry={makeEntry({ busy: true })} />);
		expect(html).toContain('data-busy="true"');
		expect(html).toContain('disabled=""');
	});
});

describe("MarketplaceGrid", () => {
	it("renders the empty-state message when no entries match", () => {
		const html = renderToStaticMarkup(<MarketplaceGrid entries={[]} />);
		expect(html).toContain("No plugins match the current filter.");
	});

	it("renders a card per entry", () => {
		const html = renderToStaticMarkup(
			<MarketplaceGrid
				entries={[makeEntry({ name: "github-mcp" }), makeEntry({ name: "slack-mcp", marketplace: "slack" })]}
			/>,
		);
		expect(html).toContain("github-mcp");
		expect(html).toContain("slack-mcp");
	});

	it("groups entries by marketplace when more than one is present", () => {
		const html = renderToStaticMarkup(
			<MarketplaceGrid
				entries={[
					makeEntry({ name: "github-mcp", marketplace: "anthropic" }),
					makeEntry({ name: "figma", marketplace: "figma-mp" }),
				]}
			/>,
		);
		expect(html).toContain("anthropic");
		expect(html).toContain("figma-mp");
	});

	it("does not render marketplace headers when only one is present", () => {
		const html = renderToStaticMarkup(<MarketplaceGrid entries={[makeEntry()]} />);
		expect(html).not.toContain("mp-section-title");
	});

	it("renders category filter chips when categories are present", () => {
		const html = renderToStaticMarkup(
			<MarketplaceGrid
				entries={[makeEntry({ category: "ai" }), makeEntry({ name: "github-mcp", category: "web" })]}
			/>,
		);
		expect(html).toContain("mp-filter-bar");
		expect(html).toContain(">ai<");
		expect(html).toContain(">web<");
	});
});
