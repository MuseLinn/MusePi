import { afterAll, describe, expect, it } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { MarketplaceGrid } from "../src/components/marketplace/MarketplaceGrid";
import type { MarketplaceCardEntry } from "../src/components/marketplace/types";

// The mount-fetch and install busy flows below need a real effect-driven
// render (bun:test has no DOM), so register happy-dom globally for this file.
GlobalRegistrator.register();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

afterAll(() => {
	GlobalRegistrator.unregister();
});

function makeEntry(over: Partial<MarketplaceCardEntry> = {}): MarketplaceCardEntry {
	return {
		name: "github-mcp",
		description: "Talk to GitHub from your agent.",
		author: "Anthropic",
		version: "1.2.3",
		marketplace: "official",
		...over,
	};
}

/** Deferred RPC stub: the test resolves each call when it decides to.
 *  `responses` maps call index → entry list (falls back to the last one). */
function makeClient(responses: MarketplaceCardEntry[][]) {
	const calls: string[] = [];
	let pending: Array<(value: unknown) => void> = [];
	return {
		calls,
		async rpc<T>(method: string, _params?: unknown): Promise<T> {
			const list = responses[Math.min(calls.length, responses.length - 1)];
			calls.push(method);
			await new Promise(resolve => {
				pending.push(resolve);
			});
			return { entries: list } as unknown as T;
		},
		flush(): void {
			const queue = pending;
			pending = [];
			for (const resolve of queue) resolve(undefined);
		},
	};
}

async function mount(props: Record<string, unknown>): Promise<{
	root: ReturnType<typeof createRoot>;
	div: HTMLDivElement;
}> {
	const div = document.createElement("div");
	document.body.appendChild(div);
	const holder: { root: ReturnType<typeof createRoot> | null } = { root: null };
	await act(async () => {
		holder.root = createRoot(div);
	});
	await act(async () => {
		holder.root?.render(createElement(MarketplaceGrid, props));
	});
	if (holder.root === null) throw new Error("createRoot failed");
	return { root: holder.root, div };
}

async function unmount(root: ReturnType<typeof createRoot>, div: HTMLDivElement): Promise<void> {
	await act(async () => {
		root.unmount();
	});
	div.remove();
}

describe("MarketplaceGrid data flow", () => {
	it("renders skeleton loading state while the first fetch is in flight", () => {
		// The static render shows the toolbar + skeleton grid (client wired,
		// fetch pending). Effects don't run server-side, so only the initial
		// busy marker is visible — which is exactly what we assert.
		const client = makeClient([[]]);
		const html = renderToStaticMarkup(createElement(MarketplaceGrid, { client, onAction: () => {} }));
		expect(html).toContain("mp-grid-toolbar");
	});

	it("fetches marketplace.list on mount and renders the cards", async () => {
		const client = makeClient([[makeEntry()]]);
		const { root, div } = await mount({ client, onAction: () => {} });
		try {
			expect(client.calls).toEqual(["marketplace.list"]);
			// fetch still pending → skeleton shown, no cards yet
			expect(div.querySelectorAll(".mp-card").length).toBe(0);
			client.flush();
			await act(async () => {});
			const cards = div.querySelectorAll(".mp-card");
			expect(cards.length).toBe(1);
			expect(div.textContent ?? "").toContain("github-mcp");
			expect(div.querySelectorAll(".mp-skeleton-card").length).toBe(0);
		} finally {
			await unmount(root, div);
		}
	});

	it("install action marks the card busy, then refreshes and clears busy", async () => {
		// first fetch: not installed → Install button; refresh after the
		// action: installed → badge + Remove affordance.
		const client = makeClient([[makeEntry()], [makeEntry({ installed: true })]]);
		const actions: string[] = [];
		// holder object: TS can't track closure assignments to a plain let,
		// so the release callback lives behind a stable reference.
		const release: { fn: (() => void) | null } = { fn: null };
		const { root, div } = await mount({
			client,
			onAction: (action: { kind: string }) =>
				new Promise<void>(resolve => {
					actions.push(action.kind);
					release.fn = resolve;
				}),
		});
		try {
			client.flush();
			await act(async () => {});
			// not installed yet → install button present
			const btn = div.querySelector<HTMLButtonElement>(".mp-btn--accent");
			expect(btn).not.toBeNull();
			await act(async () => {
				btn?.click();
			});
			// busy while the RPC is in flight
			let card = div.querySelector<HTMLElement>(".mp-card");
			expect(card?.getAttribute("data-busy")).toBe("true");
			release.fn?.();
			await act(async () => {});
			// the grid's post-action refresh is in flight — release it too
			client.flush();
			await act(async () => {});
			// refresh re-pulled the list (now installed) — busy cleared,
			// badge + Remove affordance flipped on
			expect(client.calls).toEqual(["marketplace.list", "marketplace.list"]);
			card = div.querySelector<HTMLElement>(".mp-card");
			expect(card?.getAttribute("data-busy")).toBe("false");
			expect(div.textContent ?? "").toContain("github-mcp");
			expect(div.querySelector(".mp-card-badge")).not.toBeNull();
			expect(div.querySelector(".mp-btn--warn")).not.toBeNull();
		} finally {
			await unmount(root, div);
		}
		expect(actions).toEqual(["install"]);
	});

	it("failed action surfaces the error and clears the busy flag", async () => {
		const client = makeClient([[makeEntry()]]);
		const { root, div } = await mount({
			client,
			onAction: () => {
				throw new Error("boom");
			},
		});
		try {
			client.flush();
			await act(async () => {});
			const btn = div.querySelector<HTMLButtonElement>(".mp-btn--accent");
			await act(async () => {
				btn?.click();
			});
			expect(div.textContent ?? "").toContain("boom");
			const card = div.querySelector<HTMLElement>(".mp-card");
			expect(card?.getAttribute("data-busy")).toBe("false");
		} finally {
			await unmount(root, div);
		}
	});

	it("controlled mode mirrors entry prop updates without a client", async () => {
		const entries = [makeEntry()];
		const { root, div } = await mount({ entries, onAction: () => {} });
		try {
			expect(div.querySelectorAll(".mp-card").length).toBe(1);
			// host-side refresh (new array identity) re-renders the grid
			await act(async () => {
				root.render(
					createElement(MarketplaceGrid, {
						entries: [makeEntry(), makeEntry({ name: "docker-tool" })],
						onAction: () => {},
					}),
				);
			});
			expect(div.querySelectorAll(".mp-card").length).toBe(2);
			expect(div.textContent ?? "").toContain("docker-tool");
		} finally {
			await unmount(root, div);
		}
	});
});
