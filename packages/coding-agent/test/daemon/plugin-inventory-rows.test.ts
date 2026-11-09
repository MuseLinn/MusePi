/**
 * extensions.list inventory contract: preset rows are the full, flattened
 * composition (parents first, a child replacing an inherited row in place), not
 * the old "which presets mention this name" label heuristic.
 *
 * These assertions are the guard against reintroducing classification from
 * `enabledInPresets`: the label list must stay derived from the rows, and the
 * rows must keep disabled children and the default marker.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@musepi/pi-coding-agent/config/settings";
import { ExtensionService } from "../../src/daemon/services/extension-service";
import { isolateAgentDirForTest, restoreAgentDirForTest } from "../helpers/isolate-agent-dir";

type PresetRow = { name: string; entryId: string | null; enabled: boolean; fiberPhase: "active" | "failed" | null };
type PresetView = { id: string; label: string; isDefault: boolean; rows: PresetRow[] };
type ListedExtension = { name: string; kind: string; enabledInPresets?: string[] };
type Listed = { extensions: ListedExtension[]; presets: PresetView[] };

const PARENT = {
	id: "inventory-parent",
	label: "Inventory Parent",
	plugins: [{ name: "pkg-parent" }, { name: "pkg-off" }],
};

// The child re-declares pkg-off (same id) to switch it off: the row must stay
// in its parent position with enabled=false, and a new row appends.
const CHILD = {
	id: "inventory-child",
	label: "Inventory Child",
	extends: ["inventory-parent"],
	plugins: [{ name: "pkg-off", enabled: false }, { name: "pkg-extra" }, { name: "pkg-parent" }],
};

const WHITELIST = {
	id: "inventory-whitelist",
	label: "Inventory Whitelist",
	extensions: ["inventory-fixture"],
};

async function writeMode(dir: string, id: string, body: unknown): Promise<void> {
	await fs.mkdir(dir, { recursive: true });
	await Bun.write(path.join(dir, `${id}.json`), JSON.stringify(body));
}

async function writeFixtureExtension(agentDir: string): Promise<void> {
	const dir = path.join(agentDir, "extensions", "inventory-fixture");
	await fs.mkdir(dir, { recursive: true });
	await Bun.write(path.join(dir, "index.ts"), "export default function (): void {}\n");
	await Bun.write(
		path.join(dir, "package.json"),
		JSON.stringify({ name: "inventory-fixture", musepi: { extensions: ["index.ts"] } }),
	);
}

describe("extensions.list preset inventory rows", () => {
	let agentDir: string;
	let cwd: string;
	let home: string;
	let modesDir: string;
	let service: ExtensionService;
	let listed: Listed;

	beforeAll(async () => {
		agentDir = await isolateAgentDirForTest("omp-inventory-rows-");
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-inventory-cwd-"));
		home = await fs.mkdtemp(path.join(os.tmpdir(), "omp-inventory-home-"));
		modesDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-inventory-modes-"));
		await writeFixtureExtension(agentDir);
		await writeMode(modesDir, "inventory-parent", PARENT);
		await writeMode(modesDir, "inventory-child", CHILD);
		await writeMode(modesDir, "inventory-whitelist", WHITELIST);
		service = new ExtensionService({
			settings: () => Settings.isolated(),
			ensureRegistry: async () => {},
			cwd: () => cwd,
			home: () => home,
			defaultPresetId: async () => "inventory-child",
			modesDir: () => modesDir,
			webUrl: () => null,
			webPortFile: () => path.join(agentDir, "web.port"),
			onChanged: () => {},
		});
		listed = (await service.list()) as Listed;
	}, 60000);

	afterAll(async () => {
		await Promise.all([
			restoreAgentDirForTest(agentDir),
			fs.rm(cwd, { recursive: true, force: true }),
			fs.rm(home, { recursive: true, force: true }),
			fs.rm(modesDir, { recursive: true, force: true }),
		]);
	}, 60000);

	test("folds inheritance parents-first and keeps a disabled child row in place", () => {
		const child = listed.presets.find(preset => preset.id === "inventory-child");
		expect(child).toBeDefined();
		expect(child!.rows.map(row => row.name)).toEqual(["pkg-parent", "pkg-off", "pkg-extra"]);
		expect(child!.rows.find(row => row.name === "pkg-off")?.enabled).toBe(false);
		expect(child!.rows.find(row => row.name === "pkg-parent")?.enabled).toBe(true);
	});

	test("marks one default preset from the profile selection", () => {
		const defaults = listed.presets.filter(preset => preset.isDefault);
		expect(defaults.map(preset => preset.id)).toEqual(["inventory-child"]);
	});

	test("expands a whitelist entry to a row and derives enabledInPresets from it", () => {
		const whitelist = listed.presets.find(preset => preset.id === "inventory-whitelist");
		expect(whitelist?.rows).toEqual([
			expect.objectContaining({ name: "inventory-fixture", entryId: null, enabled: true }),
		]);

		const fixture = listed.extensions.find(ext => ext.name === "inventory-fixture");
		expect(fixture).toBeDefined();
		expect(fixture!.enabledInPresets).toEqual(["Inventory Whitelist"]);

		// Every recorded label must be backed by an enabled row in that preset.
		for (const label of fixture!.enabledInPresets ?? []) {
			const preset = listed.presets.find(entry => entry.label === label);
			expect(preset).toBeDefined();
			expect(preset!.rows.some(row => row.name === "inventory-fixture" && row.enabled)).toBe(true);
		}
	});

	test("a disabled row does not contribute to the enabled-in labels", () => {
		const parent = listed.presets.find(preset => preset.id === "inventory-parent");
		expect(parent?.rows.find(row => row.name === "pkg-off")?.enabled).toBe(true);
		// pkg-off is not an installed extension name, so no label should claim it.
		const fixture = listed.extensions.find(ext => ext.name === "pkg-off");
		expect(fixture).toBeUndefined();
	});
});
