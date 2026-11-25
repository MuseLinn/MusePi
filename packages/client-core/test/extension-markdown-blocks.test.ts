import { describe, expect, it } from "bun:test";
import { markdownBlockDef } from "@musepi/client-markdown";
import { loadExtensionMarkdownBlocks } from "../src/components/transcript/extension-markdown-blocks";
import "./transcript-dom-shim";

/**
 * A contributed block is a compiled ESM module the daemon serves; a broken one
 * must cost its own kind and nothing else. Before this loader existed the
 * registry only held built-ins, so a plugin could not replace `table` or add a
 * kind of its own.
 */
describe("extension markdown blocks", () => {
	it("registers a kind whose module exports a component", async () => {
		const code = "export default function Block() { return null; }";
		const defs = await loadExtensionMarkdownBlocks([{ kind: "extension-table", label: "T", code }]);
		expect(defs).toHaveLength(1);
		expect(markdownBlockDef("extension-table")).toBeTruthy();
	});

	it("accepts a module that exports { Component }", async () => {
		const code = "export function Component() { return null; }";
		await loadExtensionMarkdownBlocks([{ kind: "extension-panel", label: "P", code }]);
		expect(markdownBlockDef("extension-panel")).toBeTruthy();
	});

	it("skips a broken module and leaves other kinds alone", async () => {
		const broken = "export default 42;";
		const defs = await loadExtensionMarkdownBlocks([
			{ kind: "extension-broken", label: "B", code: broken },
			{ kind: "table", label: "T", code: "" },
		]);
		expect(defs).toHaveLength(0);
		// The built-in table renderer is still the one in use.
		expect(markdownBlockDef("table")).toBeTruthy();
	});

	it("lets a contribution replace a built-in kind", async () => {
		const code = "export default function Replacement() { return null; }";
		await loadExtensionMarkdownBlocks([{ kind: "table", label: "T", code }]);
		const def = markdownBlockDef("table");
		expect(def).toBeTruthy();
		expect(def!.Component.name).toBe("Replacement");
	});

	it("keeps earlier kinds when a later load fails", async () => {
		const ok = "export default function A() { return null; }";
		await loadExtensionMarkdownBlocks([{ kind: "extension-a", label: "A", code: ok }]);
		await loadExtensionMarkdownBlocks([{ kind: "extension-b", label: "B", code: "export default 1;" }]);
		expect(markdownBlockDef("extension-a")).toBeTruthy();
		expect(markdownBlockDef("extension-b")).toBeFalsy();
	});
});
