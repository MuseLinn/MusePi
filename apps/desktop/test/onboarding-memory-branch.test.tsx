import "./happy-dom-shim"; // MUST be first: component module graphs define HTMLElement subclasses at evaluation time.
import { afterAll, describe, expect, test } from "bun:test";
import { setLocale } from "@musepi/client-core";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { MemorySetup } from "../src/components/OnboardingOverlay";
import type { RpcClient } from "../src/lib/rpc";

/**
 * Memory branch contract for the first-run overlay:
 *  * nothing is written until the person flips a switch, so opening and
 *    closing the branch cannot change a profile on its own;
 *  * memory off hides the idle option (it has nothing to tidy);
 *  * switching memory on picks the recommended on-device backend rather than
 *    whatever the profile had stored;
 *  * the idle option is opt-in even after memory is on.
 */

setLocale("en-US");
afterAll(() => {
	setLocale("zh-CN");
});

function fakeRpc(sent: Array<{ key: string; value: unknown }>): RpcClient {
	return {
		request: async (method: string, params?: unknown) => {
			if (method === "settings.set") {
				const { key, value } = params as { key: string; value: unknown };
				sent.push({ key, value });
			}
			return {} as never;
		},
	} as unknown as RpcClient;
}

function mount(element: Parameters<typeof createRoot>[0] extends never ? never : ReturnType<typeof createElement>) {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	act(() => root.render(element));
	// `t()` falls back to the key (minus its `settings.` namespace) when the
	// locale catalog is not mounted in a unit test, so match by suffix rather
	// than on the English copy.
	const switchFor = (label: string, key: string): HTMLButtonElement => {
		const buttons = [...container.querySelectorAll("button[role='switch']")];
		const suffix = key.replace(/^settings\./, "");
		const button = buttons.find(candidate => {
			const aria = candidate.getAttribute("aria-label") ?? "";
			return aria === label || aria === key || aria.endsWith(suffix);
		});
		if (!(button instanceof HTMLButtonElement)) {
			throw new Error(
				`missing switch: ${label} (labels: ${buttons.map(b => b.getAttribute("aria-label")).join(" | ")})`,
			);
		}
		return button;
	};
	return {
		container,
		switchFor,
		unmount: () => {
			act(() => root.unmount());
			container.remove();
		},
	};
}

describe("onboarding memory branch", () => {
	test("writes nothing until a switch is used", () => {
		const sent: Array<{ key: string; value: unknown }> = [];
		const view = mount(
			createElement(MemorySetup, {
				rpc: fakeRpc(sent),
				memoryBackend: "off",
				onMemoryBackend: () => {},
				idleEnqueue: false,
				onIdleEnqueue: () => {},
			}),
		);
		expect(sent).toEqual([]);
		view.unmount();
	});

	test("keeps the idle option hidden while memory is off", () => {
		const sent: Array<{ key: string; value: unknown }> = [];
		const view = mount(
			createElement(MemorySetup, {
				rpc: fakeRpc(sent),
				memoryBackend: "off",
				onMemoryBackend: () => {},
				idleEnqueue: false,
				onIdleEnqueue: () => {},
			}),
		);
		expect(view.container.querySelectorAll("button[role='switch']")).toHaveLength(1);
		view.unmount();
	});

	test("switching memory on selects the recommended backend", () => {
		const sent: Array<{ key: string; value: unknown }> = [];
		let backend = "off";
		const view = mount(
			createElement(MemorySetup, {
				rpc: fakeRpc(sent),
				memoryBackend: backend,
				onMemoryBackend: (next: string) => {
					backend = next;
				},
				idleEnqueue: false,
				onIdleEnqueue: () => {},
			}),
		);
		act(() => view.switchFor("Let MusePi remember across sessions", "settings.onboardingMemoryBackend").click());
		expect(backend).toBe("local");
		expect(sent).toEqual([{ key: "memory.backend", value: "local" }]);
		view.unmount();
	});

	test("the idle option stays opt-in once memory is on", () => {
		const sent: Array<{ key: string; value: unknown }> = [];
		const view = mount(
			createElement(MemorySetup, {
				rpc: fakeRpc(sent),
				memoryBackend: "local",
				onMemoryBackend: () => {},
				idleEnqueue: false,
				onIdleEnqueue: () => {},
			}),
		);
		const idle = view.switchFor("Tidy memory when I'm away", "settings.onboardingMemoryIdle");
		expect(idle.getAttribute("aria-checked")).toBe("false");
		view.unmount();
	});
});
