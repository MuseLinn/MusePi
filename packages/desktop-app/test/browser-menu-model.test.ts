import { describe, expect, test } from "bun:test";
import { browserMenuModel } from "../src/lib/browser-menu-model";

function expected(hasPage: boolean, canOpenExternal: boolean) {
	return {
		hasPage,
		canOpenExternal,
		actions: {
			find: hasPage,
			print: hasPage,
			zoom: hasPage,
			deviceToolbar: hasPage,
			focus: hasPage,
			screenshot: hasPage,
			copyUrl: hasPage,
			openExternal: hasPage && canOpenExternal,
			hardRefresh: hasPage,
			downloads: true,
			history: true,
			clearData: true,
			settings: true,
		},
	};
}

describe("browser menu availability", () => {
	test("disables every page action without an active tab while keeping global actions", () => {
		expect(browserMenuModel(null)).toEqual(expected(false, false));
	});

	test("treats about:blank as no page without disabling global actions", () => {
		expect(browserMenuModel({ url: "about:blank" })).toEqual(expected(false, false));
	});

	test("enables all actions for an HTTP page", () => {
		expect(browserMenuModel({ url: "https://example.com/docs" })).toEqual(expected(true, true));
	});

	test("keeps page controls for a nonblank local page but blocks unsupported external opening", () => {
		expect(browserMenuModel({ url: "file:///tmp/report.html" })).toEqual(expected(true, false));
	});
});
