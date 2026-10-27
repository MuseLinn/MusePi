import "./happy-dom-shim";
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { fmtTokens } from "../../client-core/src/lib/format";
import { apply } from "../../coding-agent/src/bundled-plugins/compaction-summary/index";
import { CompactionSummaryPanel } from "../../coding-agent/src/bundled-plugins/compaction-summary/ui/summary-panel";

const { act, createElement } = React;
const previousReact = (globalThis as { React?: unknown }).React;
(globalThis as { React?: unknown }).React = React;
afterAll(() => {
	(globalThis as { React?: unknown }).React = previousReact;
});

const roots = new Set<Root>();

afterEach(async () => {
	for (const root of roots) await act(async () => root.unmount());
	roots.clear();
	document.body.innerHTML = "";
});

function tab(target: string): { id: string; surface: string; target: string; label: string; readOnly: boolean } {
	return { id: `summary::${target}`, surface: "ext:panel.tab.compaction", target, label: "压缩摘要", readOnly: true };
}

async function mount(ui: React.ReactNode): Promise<{ container: HTMLElement; root: Root }> {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	roots.add(root);
	await act(async () => root.render(ui));
	return { container, root };
}

describe("compaction summary plugin", () => {
	it("registers one right-panel tab through the Cordis entry", () => {
		const registrations: unknown[] = [];
		apply({
			setLabel() {},
			registerComponent(descriptor: unknown) {
				registrations.push(descriptor);
			},
			logger: { info() {} },
		} as never);
		expect(registrations).toEqual([
			{ slot: "panel.tab.compaction", moduleUrl: "./ui/summary-panel.tsx", label: "压缩摘要", order: 20 },
		]);
	});

	it("loads the selected summary and its before/after tokens", async () => {
		const calls: unknown[] = [];
		const rpc = {
			request: async (method: string, params: unknown) => {
				calls.push([method, params]);
				return {
					entry: {
						id: "c1",
						type: "compaction",
						summary: "Current task\n\n- Keep the evidence",
						tokensBefore: 791_000,
						tokensAfter: 76_600,
						method: "soft",
					},
				};
			},
		};
		const { container } = await mount(
			createElement(CompactionSummaryPanel, {
				rpc: rpc as never,
				sessionId: "s1",
				panelTab: tab("c1"),
				formatTokens: fmtTokens,
			}),
		);
		expect(calls).toEqual([["session.compaction", { sessionId: "s1", entryId: "c1" }]]);
		expect(container.textContent).toContain("Current task");
		expect(container.textContent).toContain("Keep the evidence");
		expect(container.textContent).toContain("791");
		expect(container.textContent).toContain("76.6");
		expect(container.textContent).toContain("soft");
	});

	it("does not let a slower previous response overwrite the newly selected tab", async () => {
		const first = Promise.withResolvers<{ entry: unknown }>();
		const rpc = {
			request: async (_method: string, params: { entryId: string }) => {
				if (params.entryId === "c1") return first.promise;
				return {
					entry: { id: "c2", type: "compaction", summary: "Second summary", tokensBefore: 200, tokensAfter: 50 },
				};
			},
		};
		const { container, root } = await mount(
			createElement(CompactionSummaryPanel, {
				rpc: rpc as never,
				sessionId: "s1",
				panelTab: tab("c1"),
				formatTokens: fmtTokens,
			}),
		);
		await act(async () =>
			root.render(
				createElement(CompactionSummaryPanel, { rpc: rpc as never, sessionId: "s1", panelTab: tab("c2") }),
			),
		);
		expect(container.textContent).toContain("Second summary");
		await act(async () =>
			first.resolve({
				entry: { id: "c1", type: "compaction", summary: "Stale summary", tokensBefore: 100, tokensAfter: 10 },
			}),
		);
		expect(container.textContent).not.toContain("Stale summary");
		expect(container.textContent).toContain("Second summary");
	});

	it("surfaces a failed summary request", async () => {
		const rpc = { request: async () => Promise.reject(new Error("daemon unavailable")) };
		const { container } = await mount(
			createElement(CompactionSummaryPanel, {
				rpc: rpc as never,
				sessionId: "s1",
				panelTab: tab("c1"),
				formatTokens: fmtTokens,
			}),
		);
		expect(container.querySelector("[role=alert]")?.textContent).toContain("daemon unavailable");
	});
});
