import "./happy-dom-shim"; // MUST be first: component module graphs define HTMLElement subclasses at evaluation time.
import { afterEach, describe, expect, it } from "bun:test";
import { t } from "@musepi/client-core";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CapabilitySidePanel } from "../src/components/CapabilitySidePanel";
import {
	type CapabilityNavAction,
	clearCapabilityNav,
	publishCapabilityNav,
	subscribeCapabilityNavAction,
} from "../src/lib/capability-nav";
import type { RpcClient } from "../src/lib/rpc";
import CapabilityCenterPage, { type Tab } from "../src/plugins/capability-center/page";

/**
 * Capability-center two-tier contracts (2026-11-08).
 *
 * The user-visible failure was three tab buttons INSIDE the page header:
 * the destination had no second-tier navigation column, so it read as one
 * container with three tabs instead of rail → panel → content like 首页 /
 * 任务中心. The tabs now live in the rail's sidebar slot as an independent
 * React subtree; the `app.capability` page publishes one projection and
 * consumes the panel's actions through `lib/capability-nav`.
 *
 * These tests mount both subtrees together so they exercise the REAL bridge,
 * not a mocked harness.
 */

const mounted = new Set<Root>();

async function flush(frames = 6): Promise<void> {
	await act(async () => {
		for (let index = 0; index < frames; index++) await Bun.sleep(10);
	});
}

afterEach(async () => {
	for (const root of mounted) await act(async () => root.unmount());
	mounted.clear();
	document.body.innerHTML = "";
	clearCapabilityNav();
});

async function mount(ui: React.ReactNode): Promise<HTMLElement> {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	mounted.add(root);
	await act(async () => root.render(ui));
	await flush();
	return container;
}

function rows(container: HTMLElement): HTMLElement[] {
	return [...container.querySelectorAll<HTMLElement>("[data-capability-tab]")];
}

function activeTab(container: HTMLElement): string | null {
	return container.querySelector<HTMLElement>(".gui-side-panel-row--active")?.dataset.capabilityTab ?? null;
}

/** happy-dom does not always surface native input events to React's delegated
 * listener; drive the wired onChange through React props with the native
 * setter so the value tracker sees a real change (same pattern as
 * scheduled-panel.test.tsx). */
async function typeSearch(container: HTMLElement, value: string): Promise<void> {
	const input = container.querySelector<HTMLInputElement>(".gui-side-panel-search input")!;
	const propsKey = Object.keys(input).find(key => key.startsWith("__reactProps$"));
	if (!propsKey) throw new Error("search input has no React props");
	const props = (input as unknown as Record<string, { onChange?: (e: { target: Element }) => void }>)[propsKey];
	if (!props?.onChange) throw new Error("search input has no React onChange");
	Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set?.call(input, value);
	await act(async () => props.onChange!({ target: input }));
	await flush();
}

function capabilityRpc(): RpcClient {
	return {
		request: async (method: string): Promise<unknown> => {
			if (method === "plugins.packages") return { plugins: [{ name: "alpha", enabled: true }] };
			// Empty skill list: the installed pane still mounts (all three
			// panes stay resident), but no row requires a full skill record.
			if (method === "skills.list") return { skills: [] };
			if (method === "marketplace.list") return { entries: [] };
			if (method === "marketplace.sources.list") return { sources: [] };
			return {};
		},
		addEventListener: () => () => {},
	} as unknown as RpcClient;
}

describe("CapabilitySidePanel in the rail's sidebar slot", () => {
	it("renders one navigation column with three destinations even before the page publishes data", async () => {
		clearCapabilityNav();
		const container = await mount(<CapabilitySidePanel width={256} collapsed={false} />);

		const slot = container.querySelector<HTMLElement>(".gui-capability-slot");
		expect(slot).not.toBeNull();
		expect(slot?.classList.contains("gui-pane-side")).toBe(true);
		expect(slot?.classList.contains("gui-side-panel")).toBe(true);
		expect(slot?.style.width).toBe("256px");
		expect(container.querySelector(".gui-pane-drag")).not.toBeNull();
		expect(container.querySelector(".gui-side-panel-head")).not.toBeNull();
		expect(container.querySelector(".gui-side-panel-primary")).not.toBeNull();
		expect(container.querySelector(".gui-side-panel-search input")).not.toBeNull();
		expect(container.querySelector(".gui-side-panel-section")).not.toBeNull();
		expect(rows(container).map(row => row.dataset.capabilityTab)).toEqual(["skills", "plugins", "marketplace"]);
		// One accent for selection, no second heading that repeats the page.
		expect(container.querySelector(".gui-side-panel-section-title")?.textContent).not.toContain(
			t("tools.capabilityCenter"),
		);
		expect(activeTab(container)).toBe("skills");
	});

	it("folds to zero width while keeping the panel mounted", async () => {
		const container = await mount(<CapabilitySidePanel width={256} collapsed />);
		const slot = container.querySelector<HTMLElement>(".gui-capability-slot");
		expect(slot?.classList.contains("gui-pane-side--collapsed")).toBe(true);
		expect(slot?.style.width).toBe("0px");
		expect(container.querySelector(".gui-side-panel-scroll")).not.toBeNull();
	});

	it("follows the page's published tab and count projection", async () => {
		publishCapabilityNav({ tab: "plugins", skillsCount: 4, pluginsCount: 7 });
		const container = await mount(<CapabilitySidePanel width={256} collapsed={false} />);
		expect(activeTab(container)).toBe("plugins");
		expect(rows(container)[0]?.getAttribute("aria-selected")).toBe("false");
		expect(rows(container)[1]?.getAttribute("aria-selected")).toBe("true");
		const badges = [...container.querySelectorAll<HTMLElement>(".gui-side-panel-row .gui-side-panel-count")];
		expect(badges.map(badge => badge.textContent)).toEqual(["4", "7"]);
	});

	it("sends select / add actions to the page instead of owning tab state", async () => {
		publishCapabilityNav({ tab: "skills", skillsCount: 0, pluginsCount: 0 });
		const actions: CapabilityNavAction[] = [];
		const stop = subscribeCapabilityNavAction(action => actions.push(action));
		const container = await mount(<CapabilitySidePanel width={256} collapsed={false} />);
		await act(async () => rows(container)[2]?.click());
		await act(async () => container.querySelector<HTMLButtonElement>(".gui-side-panel-primary")?.click());
		expect(actions).toEqual([{ type: "select", tab: "marketplace" }, { type: "add" }]);
		// No local tab mutation: the page is still the single source of truth.
		expect(activeTab(container)).toBe("skills");
		stop();
	});

	it("filters the destinations and shows one compact no-match hint", async () => {
		const container = await mount(<CapabilitySidePanel width={256} collapsed={false} />);
		await typeSearch(container, t("guest.marketplace"));
		expect(rows(container).map(row => row.dataset.capabilityTab)).toEqual(["marketplace"]);
		expect(container.querySelector(".gui-side-panel-empty")).toBeNull();

		await typeSearch(container, "no-such-capability-zzz");
		expect(rows(container)).toHaveLength(0);
		expect(container.querySelector(".gui-side-panel-empty-title")?.textContent).toBe(
			t("tools.capabilityPanelNoMatches"),
		);
	});
});

describe("page <-> panel bridge", () => {
	it("a panel row switches the controlled page tab, and the CTA opens the marketplace", async () => {
		clearCapabilityNav();
		function Harness(): React.ReactNode {
			const [tab, setTab] = useState<Tab>("skills");
			return (
				<div>
					<CapabilitySidePanel width={256} collapsed={false} />
					<CapabilityCenterPage rpc={capabilityRpc()} page={{ tab, onTabChange: setTab, onBack() {} }} />
				</div>
			);
		}
		const container = await mount(<Harness />);
		expect(activeTab(container)).toBe("skills");

		const topPanes = [...container.querySelectorAll<HTMLElement>(".gui-capability-body > .gui-capability-pane")];
		await act(async () => rows(container)[1]?.click());
		await flush();
		expect(activeTab(container)).toBe("plugins");
		expect(topPanes[1]?.classList.contains("gui-capability-pane--on")).toBe(true);
		expect(container.querySelectorAll(".gui-capability-body > .gui-capability-pane--on")).toHaveLength(1);

		await act(async () => container.querySelector<HTMLButtonElement>(".gui-side-panel-primary")?.click());
		await flush();
		expect(activeTab(container)).toBe("marketplace");
		expect(topPanes[2]?.classList.contains("gui-capability-pane--on")).toBe(true);
	});

	it("unmounting the page clears the projection while the shell keeps the panel mounted", async () => {
		// Two independent roots: in the real shell the panel lives in
		// .gui-side-keeper and the page in the chat column. Unmount ONLY the
		// page so clearCapabilityNav() runs with the panel still subscribed.
		const panelHost = document.createElement("div");
		const pageHost = document.createElement("div");
		document.body.append(panelHost, pageHost);
		const panelRoot = createRoot(panelHost);
		const pageRoot = createRoot(pageHost);
		mounted.add(panelRoot);
		await act(async () => {
			panelRoot.render(<CapabilitySidePanel width={256} collapsed={false} />);
			pageRoot.render(
				<CapabilityCenterPage rpc={capabilityRpc()} page={{ tab: "plugins", onTabChange() {}, onBack() {} }} />,
			);
		});
		await flush();
		expect(activeTab(panelHost)).toBe("plugins");
		await act(async () => pageRoot.unmount());
		await flush();
		expect(activeTab(panelHost)).toBe("skills");
	});
});
