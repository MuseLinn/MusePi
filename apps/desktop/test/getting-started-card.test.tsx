import "./happy-dom-shim";
import { afterEach, describe, expect, it } from "bun:test";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
	GETTING_STARTED_STEPS,
	GETTING_STARTED_STORAGE_KEY,
	GettingStartedCard,
	readGettingStarted,
	writeGettingStarted,
} from "../src/components/GettingStartedCard";

/**
 * REA reference contract: a collapsible checklist card with a completion bar.
 * Each row opens a real host entry point; visited rows advance the bar, and
 * collapse / dismiss / progress survive a renderer reload.
 */

const mounted = new Set<Root>();
afterEach(async () => {
	for (const root of mounted) await act(async () => root.unmount());
	mounted.clear();
	document.body.innerHTML = "";
	window.localStorage.clear();
});

async function mount(card: React.ReactNode): Promise<HTMLElement> {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	mounted.add(root);
	await act(async () => root.render(card));
	return host;
}

function card(onAction: (id: string) => void = () => {}) {
	return createElement(GettingStartedCard, { onAction });
}

describe("GettingStartedCard", () => {
	it("renders every step with a zeroed progress bar", async () => {
		const host = await mount(card());
		const rows = [...host.querySelectorAll<HTMLButtonElement>(".gui-getting-started-row")];
		expect(rows).toHaveLength(GETTING_STARTED_STEPS.length);
		const bar = host.querySelector<HTMLElement>('[role="progressbar"]');
		expect(bar?.getAttribute("aria-valuenow")).toBe("0");
		expect(bar?.getAttribute("aria-valuemax")).toBe(String(GETTING_STARTED_STEPS.length));
	});

	it("opens the host action, marks the row done and persists progress", async () => {
		const opened: string[] = [];
		const host = await mount(card(id => opened.push(id)));
		await act(async () => host.querySelector<HTMLButtonElement>('[data-step="provider"]')?.click());
		expect(opened).toEqual(["provider"]);
		expect(host.querySelector('[data-step="provider"]')?.className).toContain("--done");
		expect(host.querySelector<HTMLElement>('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("1");
		expect(readGettingStarted().done).toEqual(["provider"]);

		// Re-clicking a done row still opens the entry point without double-counting.
		await act(async () => host.querySelector<HTMLButtonElement>('[data-step="provider"]')?.click());
		expect(opened).toEqual(["provider", "provider"]);
		expect(readGettingStarted().done).toEqual(["provider"]);
	});

	it("collapses and expands without unmounting the list", async () => {
		const host = await mount(card());
		const toggle = host.querySelector<HTMLButtonElement>(".gui-getting-started-toggle")!;
		await act(async () => toggle.click());
		const list = host.querySelector<HTMLElement>(".gui-getting-started-list");
		expect(list?.getAttribute("data-collapsed")).toBe("true");
		expect(list?.getAttribute("aria-hidden")).toBe("true");
		expect(readGettingStarted().collapsed).toBe(true);
		await act(async () => toggle.click());
		expect(list?.getAttribute("data-collapsed")).toBeNull();
	});

	it("restart clears progress and hide removes the card", async () => {
		writeGettingStarted({ collapsed: false, done: ["import", "task"], dismissed: false });
		const host = await mount(card());
		expect(host.querySelector<HTMLElement>('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("2");

		await act(async () => host.querySelector<HTMLButtonElement>(".gui-getting-started-more")?.click());
		const items = [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
		expect(items).toHaveLength(2);
		await act(async () => items[0]?.click());
		expect(readGettingStarted().done).toEqual([]);

		await act(async () => host.querySelector<HTMLButtonElement>(".gui-getting-started-more")?.click());
		await act(async () => host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')[1]?.click());
		expect(host.querySelector(".gui-getting-started")).toBeNull();
		expect(readGettingStarted().dismissed).toBe(true);
	});

	it("a dismissed card stays dismissed across a reload", async () => {
		writeGettingStarted({ collapsed: false, done: [], dismissed: true });
		const host = await mount(card());
		expect(host.querySelector(".gui-getting-started")).toBeNull();
		expect(localStorage.getItem(GETTING_STARTED_STORAGE_KEY)).toContain("dismissed");
	});
});
