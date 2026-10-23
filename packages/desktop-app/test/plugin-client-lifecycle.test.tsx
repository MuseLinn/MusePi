import "./happy-dom-shim"; // MUST be first: component module graphs touch DOM globals at evaluation time.
import { afterEach, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SlotComponentMount } from "../src/lib/slot-host";

/**
 * 插件客户端模块的生命周期 —— `apply(ctx)` 装下的东西必须能被拆掉。
 *
 * 守的是一个**泄漏**契约：插件在模块级装的样式 / 事件源 / window 监听，重载后
 * 旧模块永远不会再被运行，装下的东西就留在 document 里直到窗口关闭。
 *
 * 用例**驱动真正的 `SlotComponentHost`**（blob 导入真实代码、真实挂载、真实
 * 卸载），而不是复现它的步骤——复现步骤的测试会在宿主代码坏掉时照样通过。
 *
 * 断言的是可观测结果：document 里的 `<style>` 数量、EventSource 的开关、以及
 * 模块自己收到的 abort。
 */

const ITEM_BASE = {
	slot: "composer.model",
	extensionId: "/pkg/index.ts",
	label: "probe",
	order: 0,
	css: undefined as string | undefined,
};

/** Mount one component and return the root plus an unmount helper. */
function mount(code: string): { unmount: () => Promise<void> } {
	let root: Root | null = null;
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	const item = { ...ITEM_BASE, code, error: undefined as string | undefined };
	void act(() => {
		root?.render(
			createElement(SlotComponentMount as never, {
				rpc: null,
				sessionId: null,
				cwd: "/tmp",
				item: item as never,
				settingsScope: null,
			}),
		);
	});
	return {
		unmount: async () => {
			await act(async () => {
				root?.unmount();
			});
		},
	};
}

/** Let the async blob import + apply settle. */
async function settle(): Promise<void> {
	await act(async () => {
		await Bun.sleep(20);
	});
}

const stylesWithMarker = (marker: string): number =>
	document.querySelectorAll(`style[data-plugin-probe="${marker}"]`).length;

afterEach(() => {
	for (const node of document.querySelectorAll("style[data-plugin-probe]")) node.remove();
	document.body.innerHTML = "";
});

describe("plugin module apply(ctx)", () => {
	test("a module's effect() disposer runs on unmount", async () => {
		// The whole point: whatever the module installed is gone afterwards.
		const code = `
			export default function Probe() { return null; }
			export function apply(ctx) {
				const style = document.createElement("style");
				style.setAttribute("data-plugin-probe", "style");
				style.textContent = ".probe{}";
				document.head.appendChild(style);
				ctx.effect(() => style.remove());
			}
		`;
		const handle = mount(code);
		await settle();
		expect(stylesWithMarker("style")).toBe(1);
		await handle.unmount();
		expect(stylesWithMarker("style")).toBe(0);
	});

	test("a module with no apply export mounts and unmounts cleanly", async () => {
		// The common case stays exactly as it was before this seam existed.
		const code = `export default function Probe() { return null; }`;
		const handle = mount(code);
		await settle();
		await handle.unmount();
		expect(stylesWithMarker("style")).toBe(0);
	});

	test("the signal aborts on unmount, so a plugin can drop its subscriptions", async () => {
		// Hand-tracking lifetime is what plugins get wrong; the host says "done".
		const code = `
			export default function Probe() { return null; }
			export function apply(ctx) {
				window.__probeAborted = false;
				window.__probeSignal = ctx.signal;
				ctx.signal.addEventListener("abort", () => { window.__probeAborted = true; });
			}
		`;
		const handle = mount(code);
		await settle();
		expect((window as never as { __probeAborted: boolean }).__probeAborted).toBe(false);
		await handle.unmount();
		expect((window as never as { __probeAborted: boolean }).__probeAborted).toBe(true);
	});

	test("the context carries the seat and the extension identity", async () => {
		// A plugin building its own API path needs its identity; the seat tells
		// two mounts of one module apart.
		const code = `
			export default function Probe() { return null; }
			export function apply(ctx) {
				window.__probeCtx = { slot: ctx.slot, extensionId: ctx.extensionId };
			}
		`;
		const handle = mount(code);
		await settle();
		const seen = (window as never as { __probeCtx: { slot: string; extensionId: string } }).__probeCtx;
		expect(seen.slot).toBe("composer.model");
		expect(seen.extensionId).toBe("/pkg/index.ts");
		await handle.unmount();
	});

	test("disposers run in reverse order", async () => {
		// A listener registered on top of an open connection must be removed
		// before the connection.
		const code = `
			export default function Probe() { return null; }
			export function apply(ctx) {
				window.__probeOrder = [];
				ctx.effect(() => window.__probeOrder.push("connection"));
				ctx.effect(() => window.__probeOrder.push("listener"));
			}
		`;
		const handle = mount(code);
		await settle();
		await handle.unmount();
		expect((window as never as { __probeOrder: string[] }).__probeOrder).toEqual(["listener", "connection"]);
	});
});
