import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { compileComponentModule } from "./extension-artifact-compiler";

/**
 * Every table entry in `EXTENSION_HOST_MODULES` is an identity the host shares
 * with compiled plugins: the import must become `window.MusePiHostModules[key]`
 * instead of a second bundled copy. Everything else stays in the bundle.
 */
describe("extension artifact compiler host modules", () => {
	let dir: string | undefined;

	afterEach(async () => {
		if (dir) await fs.rm(dir, { recursive: true, force: true });
		dir = undefined;
	});

	async function fixture(files: Record<string, string>): Promise<string> {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "musepi-artifact-"));
		for (const [relative, contents] of Object.entries(files)) {
			const target = path.join(dir, relative);
			await fs.mkdir(path.dirname(target), { recursive: true });
			await fs.writeFile(target, contents);
		}
		return dir;
	}

	it("resolves table entries to MusePiHostModules and bundles other imports", async () => {
		const root = await fixture({
			"lib/action-toast.ts": [
				'export const ACTION_TOAST_MARKER = "bundled-action-toast-copy";',
				"export function showActionToast(message: string): string {",
				"	return `${ACTION_TOAST_MARKER}:${message}`;",
				"}",
			].join("\n"),
			"lib/prompt-dialog.ts": [
				'export const PROMPT_DIALOG_MARKER = "bundled-prompt-dialog-copy";',
				"export function useConfirm(): { confirm(message: string): Promise<boolean> } {",
				"	return { confirm: async () => PROMPT_DIALOG_MARKER.length > 0 };",
				"}",
			].join("\n"),
			"lib/bridge.ts": 'export { showActionToast } from "./action-toast";',
			"lib/leaf-walk.ts": [
				'export const LEAF_WALK_MARKER = "bundled-leaf-walk-copy";',
				"export function leafWalk(): string {",
				"	return LEAF_WALK_MARKER;",
				"}",
			].join("\n"),
			"ext/component.tsx": [
				'import { showActionToast } from "../lib/bridge";',
				'import { useConfirm } from "../lib/prompt-dialog";',
				'import { leafWalk } from "../lib/leaf-walk";',
				"",
				"export default function Component() {",
				"	const { confirm } = useConfirm();",
				"	return <button onClick={() => void confirm(showActionToast(leafWalk()))} />;",
				"}",
			].join("\n"),
		});

		const { code } = await compileComponentModule(path.join(root, "ext", "component.tsx"));

		expect(code).toContain("MusePiHostModules");
		expect(code).toContain("MusePiReact.createElement");
		expect(code).not.toContain("bundled-action-toast-copy");
		expect(code).not.toContain("bundled-prompt-dialog-copy");
		expect(code).toContain("bundled-leaf-walk-copy");
	});

	it("shares the client-core namespace and its i18n module", async () => {
		const root = await fixture({
			"ext/component.ts": [
				'import { t } from "@musepi/client-core";',
				'import { t as deepT } from "@musepi/client-core/src/i18n";',
				"",
				"export const labels = [t, deepT];",
			].join("\n"),
		});

		const { code } = await compileComponentModule(path.join(root, "ext", "component.ts"));

		expect(code).toContain("MusePiHostModules");
		expect(code).toContain('MusePiHostModules is missing "client-core"');
		expect(code).toContain('MusePiHostModules is missing "i18n"');
		// The i18n source owns the locale registry; its presence would mean the
		// import fell back to a bundled copy with its own locale state.
		expect(code).not.toContain("omp.collab.locale");
	});

	it("throws a keyed error when the host table lacks the entry", async () => {
		const root = await fixture({
			"lib/file-workspace.ts": [
				'export const FILE_WORKSPACE_MARKER = "bundled-file-workspace-copy";',
				"export function useFileWorkspace(): string {",
				"	return FILE_WORKSPACE_MARKER;",
				"}",
			].join("\n"),
			"ext/component.ts": [
				'import { useFileWorkspace } from "../lib/file-workspace";',
				"",
				"export const workspace = useFileWorkspace();",
			].join("\n"),
		});
		const { code } = await compileComponentModule(path.join(root, "ext", "component.ts"));
		const bundle = path.join(root, "bundle.mjs");
		await fs.writeFile(bundle, code);

		const host = globalThis as unknown as { window?: unknown };
		const previous = host.window;
		host.window = { MusePiHostModules: {} };
		try {
			await expect(import(pathToFileURL(bundle).href)).rejects.toThrow(
				'MusePiHostModules is missing "file-workspace"',
			);
		} finally {
			host.window = previous;
		}
	});
});
