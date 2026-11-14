import { describe, expect, it } from "bun:test";
import { entrySrc } from "../src/lib/managed-browser-host";

/**
 * `<webview src>` must stay at the URL its element was created with.
 *
 * The host re-renders on every navigation (the guest reports its new URL back
 * through `did-navigate`), so binding `src` to live state re-points the element
 * and reloads the page — the in-flight load dies with `ERR_ABORTED (-3)` over a
 * page that was loading fine. Later navigations go through `loadURL`/main.
 */
describe("entrySrc", () => {
	it("keeps the creation URL after the tab reports a new one", () => {
		expect(entrySrc("tab-a", "https://example.com/")).toBe("https://example.com/");
		expect(entrySrc("tab-a", "https://example.com/next")).toBe("https://example.com/");
	});

	it("falls back to about:blank for an empty creation URL", () => {
		expect(entrySrc("tab-b", "")).toBe("about:blank");
	});

	it("tracks tabs independently", () => {
		expect(entrySrc("tab-c", "https://a.test/")).toBe("https://a.test/");
		expect(entrySrc("tab-d", "https://b.test/")).toBe("https://b.test/");
	});
});
