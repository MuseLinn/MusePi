import "./happy-dom-shim";
import { afterEach, describe, expect, it } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { HeroComposer } from "../src/components/HeroComposer";
import type { RpcClient } from "../src/lib/rpc";

const roots = new Set<Root>();
afterEach(async () => {
	for (const root of roots) await act(async () => root.unmount());
	roots.clear();
	document.body.innerHTML = "";
	localStorage.clear();
});

function makeRpc(): RpcClient {
	return {
		request: async (method: string) => {
			if (method === "workspace.list") {
				return { workspaces: [{ root: "C:/workspace", additionalDirs: [] }] };
			}
			if (method === "workspace.tree") {
				return {
					entries: [
						{ name: "src", path: "src", isDir: true, depth: 1 },
						{ name: "app.ts", path: "src/app.ts", isDir: false, depth: 2 },
						{ name: "deep.ts", path: "src/a/b/deep.ts", isDir: false, depth: 4 },
					],
				};
			}
			if (method === "commands.list") {
				return [
					{ name: "usage", description: "usage", kind: "command", category: "TUI" },
					{ name: "context", description: "context", kind: "command", category: "TUI" },
				];
			}
			if (method.startsWith("models.list")) return [];
			return null;
		},
		addEventListener: () => () => {},
	} as unknown as RpcClient;
}

async function flush(): Promise<void> {
	await act(async () => {
		await Bun.sleep(20);
	});
}

/** Drive the controlled textarea through its React onChange. happy-dom 20's
 *  synthetic input dispatch does not reach React's value tracker for this
 *  component graph (the same harness works for a bare textarea), so the test
 *  calls the handler React attached — the wiring under test is
 *  composer → shared controller → menu, not React's event plugin. */
function type(ta: HTMLTextAreaElement, value: string): void {
	const key = Object.keys(ta).find(k => k.startsWith("__reactProps"));
	const props = key
		? (ta as unknown as Record<string, { onChange?: (e: { target: HTMLTextAreaElement }) => void }>)[key]
		: null;
	const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
	setter?.call(ta, value);
	props?.onChange?.({ target: ta });
}

describe("empty-state completion through the shared controller", () => {
	it("@ lists the shallow project tree, same controller as a session", async () => {
		const container = document.createElement("div");
		document.body.appendChild(container);
		const root = createRoot(container);
		roots.add(root);
		await act(async () => root.render(<HeroComposer onSubmit={() => {}} rpc={makeRpc()} project="C:/workspace" />));
		await flush();

		const ta = container.querySelector("textarea");
		expect(ta).not.toBeNull();
		await act(async () => {
			type(ta!, "@");
		});
		await flush();

		const rows = [...document.querySelectorAll(".gui-model-opt")].map(node => node.textContent ?? "");
		expect(rows.some(text => text.includes("src"))).toBe(true);
		// Depth cap stays an empty-state rule (2); the session @ panel has none.
		expect(rows.some(text => text.includes("deep.ts"))).toBe(false);
	});

	it("/ lists the GUI usage command even without a session", async () => {
		const container = document.createElement("div");
		document.body.appendChild(container);
		const root = createRoot(container);
		roots.add(root);
		await act(async () => root.render(<HeroComposer onSubmit={() => {}} rpc={makeRpc()} project="C:/workspace" />));
		await flush();

		const ta = container.querySelector("textarea");
		await act(async () => {
			type(ta!, "/");
		});
		await flush();

		const rows = [...document.querySelectorAll(".gui-slash-row")].map(node => node.textContent ?? "");
		expect(rows.some(text => text.includes("usage"))).toBe(true);
	});
});
