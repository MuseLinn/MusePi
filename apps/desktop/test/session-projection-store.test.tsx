import "./happy-dom-shim";
import { afterEach, describe, expect, it } from "bun:test";
import type { ContextUsageProjection } from "@musepi/pi-wire";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { GuiSessionStore } from "../src/lib/session-store";
import { useSessionProjection } from "../src/lib/use-projection";

const host = () => {
	const node = document.createElement("div");
	document.body.appendChild(node);
	return node;
};

const initial = (): ContextUsageProjection => ({
	model: "prov/m",
	tokens: 100,
	contextWindow: 1000,
	percent: 10,
	usage: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 100, cost: 0, cacheHitRate: null },
});

afterEach(() => {
	document.body.innerHTML = "";
});

describe("session projection store", () => {
	it("applies projection envelopes and seeds from the resume snapshot", () => {
		const store = new GuiSessionStore(
			"s1",
			{
				entries: [],
				cursor: 0,
				projections: { values: { contextUsage: initial() }, seq: 0 },
			},
			"C:/workspace",
		);
		expect(store.getSnapshot().projections.get("contextUsage")).toEqual(initial());
		store.apply({
			kind: "projection",
			seq: 0,
			payload: { changes: [{ key: "contextUsage", value: { ...initial(), tokens: 400, percent: 40 } }] },
		});
		expect((store.getSnapshot().projections.get("contextUsage") as ContextUsageProjection).tokens).toBe(400);
		store.dispose();
	});

	it("re-renders a key-addressed reader on a pushed change", async () => {
		const store = new GuiSessionStore(
			"s1",
			{ entries: [], cursor: 0, projections: { values: { contextUsage: initial() }, seq: 0 } },
			"C:/workspace",
		);
		const node = host();
		const root = createRoot(node);
		const reads: number[] = [];
		function Reader() {
			const value = useSessionProjection<ContextUsageProjection>(store, "contextUsage");
			reads.push(value?.tokens ?? -1);
			return null;
		}
		await act(async () => root.render(createElement(Reader)));
		expect(reads.at(-1)).toBe(100);
		await act(async () => {
			store.apply({
				kind: "projection",
				seq: 0,
				payload: { changes: [{ key: "contextUsage", value: { ...initial(), tokens: 900 } }] },
			});
		});
		expect(reads.at(-1)).toBe(900);
		await act(async () => root.unmount());
		store.dispose();
	});
});
