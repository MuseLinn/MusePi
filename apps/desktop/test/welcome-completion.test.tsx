import "./happy-dom-shim";
import { afterEach, describe, expect, it } from "bun:test";
import { EditorView } from "@codemirror/view";
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

/** Drive the CodeMirror document: the component's update listener is the
 *  same `onChange` path a real keystroke takes. The wiring under test is
 *  composer → shared controller → menu. */
function type(el: Element, value: string): void {
	const view = EditorView.findFromDOM(el as HTMLElement);
	if (!view) throw new Error("CodeMirror view not mounted");
	view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
}

describe("empty-state completion through the shared controller", () => {
	it("@ lists the shallow project tree, same controller as a session", async () => {
		const container = document.createElement("div");
		document.body.appendChild(container);
		const root = createRoot(container);
		roots.add(root);
		await act(async () => root.render(<HeroComposer onSubmit={() => {}} rpc={makeRpc()} project="C:/workspace" />));
		await flush();

		const ta = container.querySelector(".cm-content");
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

		const ta = container.querySelector(".cm-content");
		await act(async () => {
			type(ta!, "/");
		});
		await flush();

		const rows = [...document.querySelectorAll(".gui-slash-row")].map(node => node.textContent ?? "");
		expect(rows.some(text => text.includes("usage"))).toBe(true);
	});
});
