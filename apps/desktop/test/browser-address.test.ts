import { describe, expect, it } from "bun:test";
import { formatAddressDisplayParts } from "../src/lib/browser-address";

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
