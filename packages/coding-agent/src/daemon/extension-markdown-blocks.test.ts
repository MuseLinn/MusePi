/**
 * End-to-end guard for the markdown block pipeline.
 *
 * `collectMarkdownBlockViews` is what `extensions.list` serves: it loads the
 * extension, reads its declared block kinds, compiles each `moduleUrl`, and
 * ships the code. A renderer that imports React directly, references a host
 * module that is not exported, or fails to compile would silently leave the
 * block unclaimed in the GUI — this test fails instead.
 */
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PLUGIN_MODULE_KIND } from "../capability/extension-module";
import { collectMarkdownBlockViews } from "./extension-artifact-compiler";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "md-blocks-"));

afterAll(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

function writeExtension(name: string, body: string, block: string): string {
	const root = path.join(dir, name);
	fs.mkdirSync(path.join(root, "ui"), { recursive: true });
	fs.writeFileSync(path.join(root, "index.ts"), body, "utf8");
	fs.writeFileSync(path.join(root, "ui", "block.tsx"), block, "utf8");
	return path.join(root, "index.ts");
}

describe("extension markdown block renderers", () => {
	test("compiles a declared kind into a host-React module", async () => {
		const entry = writeExtension(
			"one",
			`export function apply(ctx) {
				ctx.slots.registerMarkdownBlock({
					kind: "extension-table",
					label: "Extension table",
					moduleUrl: "./ui/block.tsx",
				});
			}
			export const name = "one";
			export const inject = [];`,
			`export default function Block() { return null; }`,
		);

		const views = await collectMarkdownBlockViews([{ kind: PLUGIN_MODULE_KIND, state: "active", path: entry }], dir);
		expect(views.map(view => view.kind)).toEqual(["extension-table"]);
		const view = views[0]!;
		expect(view.error).toBeUndefined();
		expect(view.code.length).toBeGreaterThan(0);
		// React comes from the host, never a bundled copy.
		expect(view.code).not.toMatch(/require\(["']react["']\)/);
	});

	test("records a compile failure without dropping the kind", async () => {
		const entry = writeExtension(
			"two",
			`export function apply(ctx) {
				ctx.slots.registerMarkdownBlock({
					kind: "broken-block",
					label: "Broken",
					moduleUrl: "./ui/missing.tsx",
				});
			}
			export const name = "two";
			export const inject = [];`,
			``,
		);

		const views = await collectMarkdownBlockViews([{ kind: PLUGIN_MODULE_KIND, state: "active", path: entry }], dir);
		expect(views.map(view => view.kind)).toEqual(["broken-block"]);
		expect(views[0]!.error).toBeString();
		expect(views[0]!.code).toBe("");
	});
});
