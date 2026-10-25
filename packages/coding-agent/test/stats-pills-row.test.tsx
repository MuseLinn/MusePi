import { afterAll, afterEach, describe, expect, it, vi } from "bun:test";
import * as React from "react";
import { act } from "react";
import { GlobalRegistrator } from "../../client-core/node_modules/@happy-dom/global-registrator";
// @ts-expect-error The daemon compiles this renderer with its own JSX settings.
import StatsRow from "../src/bundled-plugins/stats-pills/ui/stats-row";

interface Root {
	render(node: React.ReactNode): void;
	unmount(): void;
}

const { createPortal, flushSync } = require("../../client-core/node_modules/react-dom") as {
	createPortal(children: unknown, container: unknown): unknown;
	flushSync(callback: () => void): void;
};
const { createRoot } = require("../../client-core/node_modules/react-dom/client") as {
	createRoot(container: never): Root;
};

GlobalRegistrator.register();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as Record<string, unknown>).React = { ...React, createPortal };

afterAll(() => {
	GlobalRegistrator.unregister();
	delete (globalThis as Record<string, unknown>).React;
});

afterEach(() => {
	vi.useRealTimers();
});

interface TestElement {
	textContent: string | null;
	style: { transform: string; left: string; top: string };
	click(): void;
	querySelector(selector: string): TestElement | null;
}

interface TestDocument {
	body: TestElement & {
		appendChild(child: unknown): void;
		contains(element: unknown): boolean;
	};
	head: { appendChild(child: unknown): void };
	createElement(tag: string): TestElement & { appendChild(child: unknown): void };
	querySelector(selector: string): TestElement | null;
}

const doc = (globalThis as unknown as { document: TestDocument }).document;
const view = globalThis as unknown as {
	getComputedStyle(element: TestElement): { minHeight: string };
};

interface UsageResponse {
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		totalTokens: number;
		cost: number;
		cacheHitRate: number | null;
	};
	windowStats: {
		turns: number;
		steps: number;
		llmMs: number;
		toolMs: number;
		ttftMs: number;
		ttftSteps: number;
		decodeMs: number;
		decodeTokens: number;
	};
}

const validResponse: UsageResponse = {
	usage: {
		input: 80,
		output: 20,
		cacheRead: 10,
		cacheWrite: 0,
		totalTokens: 110,
		cost: 0.01,
		cacheHitRate: 50,
	},
	windowStats: {
		turns: 1,
		steps: 2,
		llmMs: 1000,
		toolMs: 0,
		ttftMs: 100,
		ttftSteps: 1,
		decodeMs: 1000,
		decodeTokens: 20,
	},
};

type RpcOutcome =
	| { kind: "value"; value: UsageResponse | null }
	| { kind: "error" }
	| { kind: "promise"; promise: Promise<UsageResponse | null> };

function controlledRpc(outcomes: RpcOutcome[]): { request<T>(method: string): Promise<T> } {
	let index = 0;
	return {
		request<T>(_method: string): Promise<T> {
			const outcome = outcomes[Math.min(index++, outcomes.length - 1)]!;
			if (outcome.kind === "error") return Promise.reject(new Error("temporary RPC failure"));
			if (outcome.kind === "promise") return outcome.promise as Promise<T>;
			return Promise.resolve(outcome.value as T);
		},
	};
}

const StatsRowComponent = StatsRow as unknown as (props: {
	rpc: { request<T>(method: string): Promise<T> };
	sessionId: string;
}) => React.ReactNode;

async function mountStats(
	outcomes: RpcOutcome[],
	sessionId = "s1",
): Promise<{
	container: TestElement;
	root: Root;
	render(session: string): Promise<void>;
}> {
	const container = doc.createElement("div");
	doc.body.appendChild(container);
	const root = createRoot(container as never);
	const rpc = controlledRpc(outcomes);
	const render = async (session: string): Promise<void> => {
		await act(async () => {
			root.render(React.createElement(StatsRowComponent, { rpc, sessionId: session }));
			await Promise.resolve();
		});
	};
	await render(sessionId);
	return { container, root, render };
}

async function unmount(root: Root): Promise<void> {
	await act(async () => root.unmount());
}

describe("stats row session data", () => {
	it("keeps the last valid readings through same-session nulls and failures, then clears on session switch", async () => {
		vi.useFakeTimers();
		const outcomes: RpcOutcome[] = [
			{ kind: "value", value: validResponse },
			{ kind: "error" },
			{ kind: "value", value: null },
			{ kind: "value", value: null },
		];
		const { container, root, render } = await mountStats(outcomes);
		try {
			expect(container.textContent).toContain("110 tokens");
			expect(container.textContent).toContain("20.0 tok/s");

			await act(async () => {
				vi.advanceTimersByTime(3000);
				await Promise.resolve();
			});
			expect(container.textContent).toContain("110 tokens");
			await act(async () => {
				vi.advanceTimersByTime(3000);
				await Promise.resolve();
			});
			expect(container.textContent).toContain("110 tokens");
			expect(container.textContent).toContain("20.0 tok/s");

			await render("s2");
			expect(container.textContent).not.toContain("110 tokens");
			expect(container.textContent).not.toContain("20.0 tok/s");
			expect(container.textContent).toContain("—");
		} finally {
			await unmount(root);
		}
	});

	it("keeps a mounted, fixed-height row from the initial pending frame through an empty response", async () => {
		vi.useFakeTimers();
		const style = doc.createElement("style");
		style.textContent = await Bun.file(
			new URL("../src/bundled-plugins/stats-pills/ui/stats-row.css", import.meta.url),
		).text();
		doc.head.appendChild(style);
		const response = Promise.withResolvers<UsageResponse | null>();
		const { container, root } = await mountStats([
			{ kind: "promise", promise: response.promise },
			{ kind: "value", value: null },
		]);
		try {
			const row = container.querySelector(".mpstats-row");
			expect(row).not.toBeNull();
			expect(container.textContent).toContain("—");
			expect(view.getComputedStyle(row!).minHeight).toBe("32px");
			await act(async () => {
				response.resolve(null);
				await response.promise;
			});
			expect(container.querySelector(".mpstats-row")).not.toBeNull();
			expect(container.textContent).toContain("—");
			expect(view.getComputedStyle(row!).minHeight).toBe("32px");
			await act(async () => {
				vi.advanceTimersByTime(3000);
				await Promise.resolve();
			});
			expect(container.querySelector(".mpstats-row")).not.toBeNull();
			expect(view.getComputedStyle(row!).minHeight).toBe("32px");
		} finally {
			await unmount(root);
		}
	});
});

describe("stats popover geometry and motion", () => {
	it("keeps one anchored frame from entry through stability and plays exit before unmounting", async () => {
		vi.useFakeTimers();
		const { container, root } = await mountStats([{ kind: "value", value: validResponse }]);
		try {
			const button = container.querySelector('[data-composer-stat="usage"] button');
			expect(button).not.toBeNull();
			let dialog: TestElement | null = null;
			let firstFrame = { left: "", top: "", transform: "" };
			await act(async () => {
				flushSync(() => button!.click());
				dialog = doc.querySelector(".mpstats-pop");
				expect(dialog).not.toBeNull();
				expect(dialog!.style.transform).toBe("translate(-50%, -100%)");
				expect(dialog!.style.left).not.toBe("-9999px");
				expect(dialog!.style.top).not.toBe("-9999px");
				expect(dialog!.querySelector(".mpstats-pop-motion")).not.toBeNull();
				firstFrame = { left: dialog!.style.left, top: dialog!.style.top, transform: dialog!.style.transform };
			});

			await act(async () => {
				vi.advanceTimersByTime(200);
			});
			expect({ left: dialog!.style.left, top: dialog!.style.top, transform: dialog!.style.transform }).toEqual(
				firstFrame,
			);

			await act(async () => button!.click());
			expect(doc.querySelector(".mpstats-pop--closing")).not.toBeNull();
			await act(async () => {
				vi.advanceTimersByTime(160);
			});
			expect(doc.querySelector(".mpstats-pop")).toBeNull();
		} finally {
			await unmount(root);
		}
	});
});
