import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { uiBlockSignatures } from "./catalog";

/**
 * The catalog and the text that teaches it must not drift. A component the
 * model is never told about is dead code; a component the guidance names but
 * the catalog dropped draws an error at the user.
 */

const agentRoot = path.resolve(import.meta.dir, "../../../coding-agent/src");

async function read(relative: string): Promise<string> {
	return Bun.file(path.join(agentRoot, relative)).text();
}

describe("ui block guidance", () => {
	test("the genui plugin's prompt section names every component the catalog draws", async () => {
		const prompt = await read("bundled-plugins/visuals/visual-answers.md");
		for (const signature of uiBlockSignatures()) {
			expect(prompt).toContain(signature.slice(0, signature.indexOf("(")));
		}
	});

	test("that section teaches the language, the fence and the root rule", async () => {
		const prompt = await read("bundled-plugins/visuals/visual-answers.md");
		expect(prompt).toContain("```ui");
		expect(prompt).toContain("root = Stack");
		expect(prompt).toContain("positional");
	});

	test("the widget tool description routes data away from pages", async () => {
		const description = await read("bundled-plugins/visuals/prompt.md");
		expect(description).toContain("```ui");
		expect(description).not.toContain("|`html`|");
	});
});
