import { describe, expect, test } from "bun:test";
import { panelBrowserPreviewUrl } from "../src/lib/file-workspace";

describe("panelBrowserPreviewUrl", () => {
	test("keeps the URL separator before a Windows drive path", () => {
		expect(panelBrowserPreviewUrl("D:\\Projects\\MusePi\\web\\index.html")).toBe(
			"musepi-file://localhost/D:/Projects/MusePi/web/index.html",
		);
	});

	test("keeps POSIX absolute paths single-rooted", () => {
		expect(panelBrowserPreviewUrl("/tmp/artifact.html")).toBe("musepi-file://localhost/tmp/artifact.html");
	});

	test("encodes spaces and non-ASCII path segments", () => {
		expect(panelBrowserPreviewUrl("/tmp/a b/页面.html")).toBe(
			"musepi-file://localhost/tmp/a%20b/%E9%A1%B5%E9%9D%A2.html",
		);
	});
});
