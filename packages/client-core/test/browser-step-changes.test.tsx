import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { setLocale, t } from "../src/i18n";
import type { BrowserStepChange } from "../src/tool-render/tools/browser-activity";
import { StepChanges, StepReceipt } from "../src/tool-render/tools/browser-step-changes";

function render(changes: BrowserStepChange[] | null): string {
	return renderToStaticMarkup(createElement(StepChanges, { changes }));
}

describe("browser step changes", () => {
	it("lists each changed field as before → after", () => {
		setLocale("en-US");
		const html = render([
			{ key: "pageTitle", before: "Form", after: "Done" },
			{ key: "url", before: "https://a.test/form", after: "https://a.test/done" },
			{ key: "loading", before: true, after: false },
		]);
		expect(html).toContain("Changed by this step");
		expect(html).toContain("Page");
		expect(html).toContain("Form");
		expect(html).toContain("Done");
		expect(html).toContain("Current URL");
		expect(html).toContain("https://a.test/form");
		expect(html).toContain("Loading");
		expect(html).toContain("Yes");
		expect(html).toContain("No");
	});

	it("says the page stood still instead of rendering an empty list", () => {
		setLocale("zh-CN");
		const html = render([]);
		expect(html).toContain("页面状态没有变化");
		expect(html).not.toContain("tv-browser-step-change-list");
	});

	it("stays silent when the step has no comparable pair", () => {
		const html = render(null);
		expect(html).toBe("");
	});
});

describe("browser step receipt", () => {
	it("shows the previous step's view labelled as the state before this step", () => {
		const html = renderToStaticMarkup(createElement(StepReceipt, { thumbnail: "data:image/jpeg;base64,AAAA" }));
		expect(html).toContain("data:image/jpeg;base64,AAAA");
		expect(html).toContain("tv-browser-step-receipt");
		expect(html).toContain(`>${t("tools.browserStepBefore")}<`);
	});

	it("renders nothing for the first step of a run", () => {
		expect(renderToStaticMarkup(createElement(StepReceipt, { thumbnail: undefined }))).toBe("");
	});
});
