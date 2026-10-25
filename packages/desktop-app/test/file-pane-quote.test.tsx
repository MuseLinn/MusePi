import "./happy-dom-shim";
import { afterEach, describe, expect, it } from "bun:test";
import type { DisplayContext } from "@musepi/pi-wire";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { FilePane } from "../src/components/FilePane";
import type { RpcClient } from "../src/lib/rpc";

const source = "first\nconst answer = 42;\nlast";
const rpc = {
	request: async (method: string) => {
		if (method === "workspace.tree") return { entries: [] };
		if (method === "fs.readBytes") return { base64: btoa(source), size: source.length, mime: "text/typescript" };
		return null;
	},
	addEventListener: () => () => {},
} as unknown as RpcClient;

const mounted = new Set<Root>();

async function settle(): Promise<void> {
	await act(async () => {
		await Bun.sleep(5);
	});
}

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (predicate()) return;
		await settle();
	}
	throw new Error("condition did not become true");
}

afterEach(async () => {
	for (const root of mounted) await act(async () => root.unmount());
	mounted.clear();
	document.body.innerHTML = "";
});

describe("FilePane quote producer", () => {
	it("emits the selected code and its source range as a structured file quote", async () => {
		const container = document.createElement("div");
		document.body.appendChild(container);
		const root = createRoot(container);
		mounted.add(root);
		await act(async () =>
			root.render(<FilePane rpc={rpc} cwd="/workspace" openRequest={{ path: "src/example.ts", nonce: 1 }} />),
		);
		await waitFor(() => container.querySelector(".gui-filepane-preview-text") !== null);
		const textNode = container.querySelector(".gui-filepane-preview-text")?.firstChild;
		if (!textNode) throw new Error("source preview did not render");
		const start = textNode.textContent?.indexOf("const answer") ?? -1;
		const range = document.createRange();
		range.setStart(textNode, start);
		range.setEnd(textNode, start + "const answer = 42;".length);
		const selection = window.getSelection();
		selection?.removeAllRanges();
		selection?.addRange(range);
		let emitted: DisplayContext | undefined;
		const onQuote = (event: Event): void => {
			emitted = (event as CustomEvent<{ displayContext: DisplayContext }>).detail.displayContext;
		};
		window.addEventListener("musepi-gui-quote-append", onQuote);
		try {
			await act(async () => container.querySelector<HTMLButtonElement>(".gui-filepane-quote")?.click());
		} finally {
			window.removeEventListener("musepi-gui-quote-append", onQuote);
		}
		expect(emitted).toEqual({
			kind: "file-quote",
			path: "src/example.ts",
			quote: "const answer = 42;",
			language: "ts",
			startLine: 2,
			endLine: 2,
		});
	});
});
