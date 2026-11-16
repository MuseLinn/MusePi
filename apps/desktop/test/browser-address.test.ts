import { describe, expect, it } from "bun:test";
import { formatAddressDisplayParts, pageIcon, pageIconUrl } from "../src/lib/browser-address";

describe("browser address display", () => {
	it("keeps a blank address empty", () => {
		expect(formatAddressDisplayParts("about:blank", "New Tab", false)).toEqual({ url: "" });
	});

	it("preserves the existing full-URL display by default", () => {
		expect(formatAddressDisplayParts("https://www.example.com/docs/", "Documentation")).toEqual({
			url: "https://www.example.com/docs",
			title: "Documentation",
		});
	});

	it("reduces a URL to its hostname when full URLs are disabled", () => {
		expect(formatAddressDisplayParts("https://www.example.com/docs?q=browser", "Documentation", false)).toEqual({
			url: "example.com",
			title: "Documentation",
		});
	});

	it("does not repeat a title that duplicates the address label", () => {
		expect(formatAddressDisplayParts("https://example.com/", "example.com", false)).toEqual({ url: "example.com" });
	});
});

// The address bar shows one icon slot for every page. `/favicon.ico` is the
// only location a renderer can reach (the guest's <link rel=icon> is in another
// document), so the icon must degrade to a glyph instead of a broken image.
describe("browser address icon", () => {
	it("guesses /favicon.ico at the page origin, ignoring path and query", () => {
		expect(pageIconUrl("https://www.example.com/docs/page?q=1")).toBe("https://www.example.com/favicon.ico");
		expect(pageIconUrl("http://localhost:3000/app")).toBe("http://localhost:3000/favicon.ico");
	});

	it("offers no icon for a page that is not on the web", () => {
		expect(pageIconUrl("about:blank")).toBeUndefined();
		expect(pageIconUrl("musepi-file:///tmp/a.html")).toBeUndefined();
		expect(pageIconUrl("")).toBeUndefined();
	});

	it("falls back to the glyph when the guessed icon fails to load", () => {
		const page = "https://www.example.com/docs";
		const icon = pageIconUrl(page);
		// Before any load attempt the guess is still shown…
		expect(pageIcon(page, null)).toEqual({ src: icon, failed: false });
		// …and once that exact icon fails, the slot draws the glyph instead of a
		// broken image.
		expect(pageIcon(page, icon ?? null).failed).toBe(true);
	});

	it("forgets a failure once another page loads", () => {
		const failed = pageIconUrl("https://a.example/") ?? null;
		expect(pageIcon("https://b.example/", failed)).toEqual({ src: pageIconUrl("https://b.example/"), failed: false });
	});
});
