import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import { afterAll, afterEach, describe, expect, it } from "bun:test";
import type { CompactionEntry } from "@musepi/pi-wire";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { t } from "../../i18n/index.js";
import { CompactionCard } from "./compaction-card";

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

function entry(overrides: Partial<CompactionEntry> = {}): CompactionEntry {
	return {
		type: "compaction",
		id: "c1",
		parentId: null,
		timestamp: "2026-11-26T00:00:00.000Z",
		summary: "long-summary-body",
		shortSummary: "short-summary-tag",
		firstKeptEntryId: "k1",
		tokensBefore: 1_000_000,
		tokensAfter: 108_000,
		...overrides,
	} as CompactionEntry;
}

describe("CompactionCard", () => {
	it("states the before/after counts and what the pass freed", () => {
		const div = render(<CompactionCard entry={entry()} />);
		expect(div.textContent).toContain(t("transcript.compactedAuto"));
		// Rendered through the shared token formatter, not raw integers.
		expect(div.querySelector(".tr-compact-tokens")?.textContent).toBe("1.0M → 108k tokens");
		expect(div.querySelector(".tr-compact-saved")?.textContent).toBe(
			t("transcript.compactionSaved", { saved: "892k" }),
		);
	});

	it("falls back to the plain label when the entry predates tokensAfter", () => {
		const div = render(<CompactionCard entry={entry({ tokensAfter: undefined })} />);
		expect(div.textContent).toContain(t("transcript.compactedPlain"));
		expect(div.querySelector(".tr-compact-saved")).toBeNull();
		expect(div.querySelector(".tr-compact-tokens")).toBeNull();
	});

	it("shows no saving badge when nothing was freed", () => {
		const div = render(<CompactionCard entry={entry({ tokensBefore: 100, tokensAfter: 120 })} />);
		expect(div.querySelector(".tr-compact-saved")).toBeNull();
	});

	it("offers no control and no chevron without an open handler", () => {
		const div = render(<CompactionCard entry={entry()} />);
		expect(div.querySelector("button")).toBeNull();
		expect(div.querySelector(".tr-compact-chevron")).toBeNull();
		expect(div.querySelector(".tr-compact-static")).not.toBeNull();
	});

	it("opens on the first click", () => {
		const opened: string[] = [];
		const div = render(<CompactionCard entry={entry()} onOpen={e => opened.push(e.id)} onClose={() => {}} />);
		const button = div.querySelector("button");
		expect(button).not.toBeNull();
		expect(button!.getAttribute("aria-expanded")).toBe("false");

		act(() => button!.click());
		expect(opened).toEqual(["c1"]);
	});

	it("closes instead of reopening while its summary is the open tab", () => {
		let opened = 0;
		let closed = 0;
		const div = render(
			<CompactionCard entry={entry()} open onOpen={() => (opened += 1)} onClose={() => (closed += 1)} />,
		);
		const button = div.querySelector("button")!;
		expect(button.getAttribute("aria-expanded")).toBe("true");

		act(() => button.click());
		expect(closed).toBe(1);
		expect(opened).toBe(0);
	});

	it("carries the summary in the title attribute", () => {
		const div = render(<CompactionCard entry={entry()} />);
		expect(div.querySelector(".tr-compact-card")?.getAttribute("title")).toBe("short-summary-tag");
	});
});
