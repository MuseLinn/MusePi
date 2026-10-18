import "./happy-dom-shim"; // MUST be first: component module graphs touch DOM globals at evaluation time.
import { afterEach, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ExtensionStatusCard } from "../src/components/ExtensionStatusCard";
import type { RpcClient } from "../src/lib/rpc";

/**
 * ExtensionStatusCard's status popup must escape the composer's clip.
 *
 * The session composer is always `hero`, so its children render inside
 * `BorderBeam`, whose injected stylesheet declares
 * `[data-beam="<id>"] { overflow: hidden }` (vendor/border-beam/styles.ts).
 * The popup used to be an in-card `absolute bottom-full` box, so the upward
 * list was clipped at the input card's top edge and only ever painted over its
 * own textarea (user report 2026-10-18).
 *
 * Contracts:
 * - the popup mounts OUTSIDE the card that carries the trigger (portal), so no
 *   clipping ancestor applies;
 * - it carries no self-positioning, so the shared floating shell owns placement;
 * - the trigger announces a menu, and the rows are exposed as menu items.
 */

const mounted: { host: HTMLDivElement; root: Root }[] = [];

afterEach(() => {
	while (mounted.length > 0) {
		const entry = mounted.pop();
		if (!entry) continue;
		act(() => entry.root.unmount());
		entry.host.remove();
	}
	document.body.innerHTML = "";
});

/**
 * The registry hook polls `extensions.list` and subscribes to `extensions.changed`
 * through `rpc.addEventListener`. A stub client supplies exactly that surface
 * with three active `extension-module:*` entries — the shape the component
 * filters and counts.
 */
function stubRpc(): RpcClient {
	const extensions = [
		{ id: "extension-module:alpha", name: "alpha", state: "active" },
		{ id: "extension-module:beta", name: "beta", state: "active" },
		{ id: "extension-module:gamma", name: "gamma", state: "active" },
	];
	return {
		request: async () => ({
			extensions,
			tabs: [],
			providers: [],
			components: [],
			toolViews: [],
			statusBarSegments: [],
			slots: { exact: [], prefixes: [] },
		}),
		addEventListener: () => () => {},
	} as unknown as RpcClient;
}

async function renderCard(): Promise<HTMLDivElement> {
	const rootHost = document.createElement("div");
	rootHost.id = "root";
	document.body.appendChild(rootHost);
	const host = document.createElement("div");
	rootHost.appendChild(host);
	const root = createRoot(host);
	mounted.push({ host, root });

	await act(async () => {
		root.render(createElement(ExtensionStatusCard, { rpc: stubRpc() }));
	});
	// The registry hook resolves on a timer/effect; let its microtasks settle.
	await act(async () => {
		await Promise.resolve();
	});
	return rootHost;
}

describe("extension status popup", () => {
	test("mounts outside the clipping composer card", async () => {
		const rootHost = await renderCard();
		const trigger = rootHost.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]');
		expect(trigger).not.toBeNull();

		await act(async () => {
			trigger!.click();
		});

		const menu = rootHost.querySelector<HTMLElement>(".gui-ext-status-menu");
		expect(menu).not.toBeNull();
		// The whole point: not a descendant of the trigger's card, so the
		// composer's overflow clipping cannot reach it.
		expect(trigger!.closest(".relative")!.contains(menu!)).toBe(false);
		expect(menu!.closest(".gui-composer-frame")).toBeNull();
	});

	test("the floating shell places the popup, not the component", async () => {
		const rootHost = await renderCard();
		const trigger = rootHost.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]');
		await act(async () => {
			trigger!.click();
		});

		const menu = rootHost.querySelector<HTMLElement>(".gui-ext-status-menu");
		expect(menu).not.toBeNull();
		// `useFloatingMenu` puts the caller's className on its portal WRAPPER, so
		// the element carrying our class is the shell — and the shell is the one
		// that must own `position: fixed` (an in-card `absolute` is the shape
		// that clipped). The inner `<div role="menu">` must stay in flow.
		expect(menu!.style.position).toBe("fixed");
		const inner = menu!.querySelector<HTMLElement>("[role='menu']");
		expect(inner).not.toBeNull();
		expect(inner!.style.position).toBe("");
		// Inner rows are in-flow too: no leftover `bottom-full` self-placement.
		const row = menu!.querySelector<HTMLElement>(".gui-ext-status-row");
		expect(row).not.toBeNull();
		expect(row!.style.position).toBe("");
	});

	test("exposes the running extensions as menu items", async () => {
		const rootHost = await renderCard();
		const trigger = rootHost.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]');
		await act(async () => {
			trigger!.click();
		});

		const items = rootHost.querySelectorAll("[role='menuitem']");
		expect(items.length).toBeGreaterThanOrEqual(3);
		const text = rootHost.textContent ?? "";
		expect(text).toContain("alpha");
		expect(text).toContain("gamma");
	});
});
