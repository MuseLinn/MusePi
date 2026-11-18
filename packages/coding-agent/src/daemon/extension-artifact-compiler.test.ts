import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
	collectSlotComponents,
	compileComponentModule,
	invalidateExtensionCaches,
	sourceStamp,
} from "./extension-artifact-compiler";

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

	it("externalizes client-core's own relative i18n import and bundles another package's", async () => {
		const root = await fixture({
			"client-core/src/i18n/index.ts": [
				'export const I18N_MARKER = "bundled-client-core-i18n-copy";',
				"export function t(key: string): string {",
				"	return `${I18N_MARKER}:${key}`;",
				"}",
			].join("\n"),
			"client-core/src/components/demo.tsx": [
				'import { t } from "../i18n/index.js";',
				"",
				"export default function Demo() {",
				'	return <span>{t("hello")}</span>;',
				"}",
			].join("\n"),
			"other/src/i18n/index.ts": [
				'export const I18N_MARKER = "bundled-other-i18n-copy";',
				"export function t(key: string): string {",
				"	return `${I18N_MARKER}:${key}`;",
				"}",
			].join("\n"),
			"other/src/components/demo.tsx": [
				'import { t } from "../i18n/index.js";',
				"",
				"export default function Demo() {",
				'	return <span>{t("hello")}</span>;',
				"}",
			].join("\n"),
		});

		const shared = await compileComponentModule(path.join(root, "client-core", "src", "components", "demo.tsx"));
		expect(shared.code).toContain('MusePiHostModules is missing "i18n"');
		expect(shared.code).not.toContain("bundled-client-core-i18n-copy");

		const bundled = await compileComponentModule(path.join(root, "other", "src", "components", "demo.tsx"));
		expect(bundled.code).not.toContain('MusePiHostModules is missing "i18n"');
		expect(bundled.code).toContain("bundled-other-i18n-copy");
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

/**
 * A cold daemon used to rebuild the whole plugin composition before its first
 * `extensions.list` could answer. The artifact must survive the process that
 * compiled it, and must still be replaced when its inputs move.
 */
describe("extension artifact disk cache", () => {
	let fixtureDir: string | undefined;
	let cacheDir: string | undefined;

	afterEach(async () => {
		delete process.env.MUSEPI_EXTENSION_ARTIFACT_CACHE;
		invalidateExtensionCaches();
		if (fixtureDir) await fs.rm(fixtureDir, { recursive: true, force: true });
		if (cacheDir) await fs.rm(cacheDir, { recursive: true, force: true });
		fixtureDir = undefined;
		cacheDir = undefined;
	});

	it("serves the stored artifact and rebuilds once a source moves", async () => {
		cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "musepi-artifact-cache-"));
		process.env.MUSEPI_EXTENSION_ARTIFACT_CACHE = cacheDir;
		fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "musepi-artifact-src-"));
		const entry = path.join(fixtureDir, "component.ts");
		await fs.writeFile(entry, 'export const MARK = "compiled";');

		const first = await compileComponentModule(entry);
		expect(first.code).toContain("compiled");

		const records = await fs.readdir(cacheDir);
		expect(records).toHaveLength(1);
		const recordPath = path.join(cacheDir, records[0]!);
		const record = JSON.parse(await fs.readFile(recordPath, "utf8")) as { code: string };
		record.code = 'export const MARK = "from-disk-cache";';
		await fs.writeFile(recordPath, JSON.stringify(record));

		// A fresh daemon has no in-process cache: it reads the stored artifact.
		invalidateExtensionCaches();
		const second = await compileComponentModule(entry);
		expect(second.code).toContain("from-disk-cache");

		// The entry moved, so the stored artifact no longer decides the output.
		await fs.writeFile(entry, 'export const MARK = "recompiled";');
		const third = await compileComponentModule(entry);
		expect(third.code).toContain("recompiled");
	});
});

/**
 * A host that builds its own plugins publishes a manifest; the daemon must
 * serve that artifact without compiling, and must stop trusting it the moment
 * its inputs move. Both halves matter: a miss costs a recompile, a stale hit
 * ships code that no longer matches the source.
 */
describe("build-time plugin artifacts", () => {
	let fixtureDir: string | undefined;
	let artifactDir: string | undefined;

	afterEach(async () => {
		delete process.env.MUSEPI_PLUGIN_ARTIFACTS;
		invalidateExtensionCaches();
		if (fixtureDir) await fs.rm(fixtureDir, { recursive: true, force: true });
		if (artifactDir) await fs.rm(artifactDir, { recursive: true, force: true });
		fixtureDir = undefined;
		artifactDir = undefined;
	});

	it("serves the prebuilt artifact and ignores it once the entry moves", async () => {
		artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), "musepi-prebuilt-"));
		fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "musepi-prebuilt-src-"));
		const entry = path.join(fixtureDir, "page.tsx");
		await fs.writeFile(entry, 'export const MARK = "source";');
		const info = await fs.stat(entry);
		await fs.writeFile(path.join(artifactDir, "page.js"), 'export const MARK = "prebuilt";');
		await fs.writeFile(
			path.join(artifactDir, "manifest.json"),
			JSON.stringify({
				stamp: sourceStamp(entry),
				entries: {
					[entry.replaceAll("\\", "/")]: { file: "page.js", mtimeMs: info.mtimeMs, size: info.size },
				},
			}),
		);
		process.env.MUSEPI_PLUGIN_ARTIFACTS = artifactDir;

		const hit = await compileComponentModule(entry);
		expect(hit.code).toContain("prebuilt");

		// The entry changed after the build: the manifest no longer describes it.
		invalidateExtensionCaches();
		await fs.writeFile(entry, 'export const MARK = "source-two";');
		const rebuilt = await compileComponentModule(entry);
		expect(rebuilt.code).toContain("source-two");
	});
});

/**
 * Slot declarations lifted at build time are what keep the first registry call
 * from mounting every plugin. The proof is a plugin entry that cannot possibly
 * load — its `index.ts` exports nothing a plugin runtime accepts — yet the slot
 * still appears, because nothing tried to load it.
 */
describe("build-time slot declarations", () => {
	let pluginDir: string | undefined;
	let artifactDir: string | undefined;

	afterEach(async () => {
		delete process.env.MUSEPI_PLUGIN_ARTIFACTS;
		invalidateExtensionCaches();
		if (pluginDir) await fs.rm(pluginDir, { recursive: true, force: true });
		if (artifactDir) await fs.rm(artifactDir, { recursive: true, force: true });
		pluginDir = undefined;
		artifactDir = undefined;
	});

	it("assembles a slot without loading the plugin", async () => {
		pluginDir = await fs.mkdtemp(path.join(os.tmpdir(), "musepi-declared-plugin-"));
		artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), "musepi-declared-artifacts-"));
		const entry = path.join(pluginDir, "index.ts");
		await fs.writeFile(entry, 'throw new Error("this module must not be loaded");');
		await fs.writeFile(path.join(artifactDir, "demo-page.js"), "export default () => null;");
		await fs.writeFile(
			path.join(artifactDir, "manifest.json"),
			JSON.stringify({
				stamp: 0,
				entries: {},
				declarations: {
					[entry.replaceAll("\\", "/")]: [{ slot: "main.conversation", file: "demo-page.js", label: "会话" }],
				},
			}),
		);
		process.env.MUSEPI_PLUGIN_ARTIFACTS = artifactDir;

		const components = await collectSlotComponents(
			[{ kind: "plugin-module", state: "active", path: entry }],
			process.cwd(),
		);
		expect(components).toHaveLength(1);
		expect(components[0]?.slot).toBe("main.conversation");
		expect(components[0]?.label).toBe("会话");
		expect(components[0]?.code).toBe("");
		expect(components[0]?.codeFile).toBe(path.join(artifactDir, "demo-page.js"));
	});
});
