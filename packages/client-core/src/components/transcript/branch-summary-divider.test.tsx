import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { t } from "../../i18n/index.js";
import { BranchSummaryDivider } from "./branch-summary-divider";

afterAll(() => {
	void GlobalRegistrator.unregister();
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
	act(() => root?.unmount());
	host?.remove();
	root = null;
	host = null;
});

function render(node: React.ReactNode): HTMLDivElement {
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	act(() => root?.render(node));
	return host;
}

describe("BranchSummaryDivider", () => {
	it("leads the caption with the shared fork glyph and keeps the label", () => {
		const div = render(<BranchSummaryDivider summary="abandoned path" />);
		const separator = div.querySelector('[role="separator"]');
		expect(separator).not.toBeNull();
		// The accessible name is the label text, unchanged by the glyph.
		expect(separator!.getAttribute("aria-label")).toBe(t("settings.branchSummary"));
		expect(separator!.textContent).toContain(t("settings.branchSummary"));
		expect(separator!.getAttribute("title")).toBe("abandoned path");
		// The fork artwork is the same glyph the branch switcher uses.
		const glyph = separator!.querySelector("svg.lucide-git-fork");
		expect(glyph).not.toBeNull();
		expect(glyph!.getAttribute("aria-hidden")).toBe("true");
	});

	it("keeps the glyph inside one caption group with the label", () => {
		const div = render(<BranchSummaryDivider summary="s" />);
		const caption = div.querySelector(".tr-branch-summary-caption");
		expect(caption).not.toBeNull();
		expect(caption!.querySelector("svg")).not.toBeNull();
		expect(caption!.textContent).toBe(t("settings.branchSummary"));
	});
});
