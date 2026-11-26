import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadExtensions } from "../src/extensibility/extensions/loader";
import { readExtensionPluginLabel } from "../src/extensibility/extensions/plugin-manifest";

/**
 * `ctx.setLabel` is not a UI name: it fills `Extension.label`, which the agent's
 * `extensions-inventory` prompt section (and the legacy `plugins.list` readout)
 * render. That surface is composed once, in one language — the name must not
 * vary with the interface locale.
 *
 * The manifest is the single home for it, so the loader seeds `Extension.label`
 * from `musepi.label`; a first-party plugin that also called `setLabel` would be
 * a second declaration free to drift (41 of 52 had drifted, 5 had none at all and
 * listed as bare directory names).
 */
const PACKAGES = path.join(import.meta.dir, "..", "src", "plugins");
const temporaryDirs: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function fixture(apply: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "musepi-extension-label-"));
	temporaryDirs.push(dir);
	await Bun.write(
		path.join(dir, "package.json"),
		JSON.stringify({ name: "fixture-plugin", type: "module", musepi: { label: "Fixture Label" } }),
	);
	const entry = path.join(dir, "index.ts");
	await Bun.write(entry, `export function apply(pi: any): void {\n${apply}\n}\n`);
	return entry;
}

/** Every bundled plugin package, whether it sits at `<root>/<pkg>` or in a
 *  `<root>/<domain>/<pkg>` group. */
async function bundledEntries(): Promise<string[]> {
	const found: string[] = [];
	const walk = async (dir: string): Promise<void> => {
		for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const child = path.join(dir, entry.name);
			if (await fs.exists(path.join(child, "package.json"))) found.push(path.join(child, "index.ts"));
			else await walk(child);
		}
	};
	await walk(PACKAGES);
	return found;
}

describe("extension label", () => {
	test("defaults to the manifest label, so the loader and the inventory agree", async () => {
		const loaded = await loadExtensions([await fixture("")], process.cwd());
		expect(loaded.errors).toEqual([]);
		expect(loaded.extensions[0]?.label).toBe("Fixture Label");
	});

	test("setLabel still wins for a plugin that names itself at runtime", async () => {
		const loaded = await loadExtensions([await fixture('pi.setLabel("Runtime Name");')], process.cwd());
		expect(loaded.extensions[0]?.label).toBe("Runtime Name");
	});

	test("first-party plugins declare no label of their own", async () => {
		const offenders: string[] = [];
		for (const entry of await bundledEntries()) {
			if (/\.setLabel\(/.test(await fs.readFile(entry, "utf8"))) offenders.push(path.relative(PACKAGES, entry));
		}
		expect(offenders).toEqual([]);
	});

	test("every bundled plugin declares a manifest label", async () => {
		const missing: string[] = [];
		for (const entry of await bundledEntries()) {
			if (!(await readExtensionPluginLabel(entry))) missing.push(path.relative(PACKAGES, entry));
		}
		expect(missing).toEqual([]);
	});
});
