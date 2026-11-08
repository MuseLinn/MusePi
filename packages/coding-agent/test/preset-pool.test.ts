/**
 * Preset generations shared by sessions (dsh's agent-preset registry).
 *
 * One mount per `(runtime, preset)`; sessions join and leave with a lease. A
 * changed definition retires the generation: new sessions get the new one, and
 * the old one is disposed when its last session leaves.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ExtensionRuntime } from "../src/extensibility/extensions/loader";
import { acquirePreset, type PresetLeaseOptions } from "../src/extensibility/plugins/preset-pool";
import type { PresetPluginRow } from "../src/presets/resolve";
import { EventBus } from "../src/utils/event-bus";

declare global {
	var __presetPoolDisposed: boolean | undefined;
}

let cwd: string;
let runtime: ExtensionRuntime;

beforeEach(() => {
	cwd = fs.mkdtempSync(path.join(os.tmpdir(), "musepi-preset-pool-"));
	runtime = new ExtensionRuntime();
	globalThis.__presetPoolDisposed = false;
});

afterEach(() => {
	fs.rmSync(cwd, { recursive: true, force: true });
});

function optionsWith(source: string): PresetLeaseOptions {
	const file = path.join(cwd, "pkg.js");
	fs.writeFileSync(file, source.replaceAll("__MARK__", "globalThis.__presetPoolDisposed = true"), "utf8");
	return {
		cwd,
		eventBus: new EventBus(),
		runtime,
		readConfig: async () => ({ fields: [], values: {} }),
		entryResolver: { resolveEntries: async () => new Map([["pkg", [file]]]) },
	};
}

const ROWS: PresetPluginRow[] = [{ name: "pkg" }];

describe("preset pool", () => {
	test("shares one generation across sessions and keeps it while a user remains", async () => {
		const options = optionsWith("export default function (pi) { pi.effect(() => { __MARK__; }); }");
		const first = await acquirePreset(runtime, "preset", ROWS, options);
		const second = await acquirePreset(runtime, "preset", ROWS, options);

		expect(second.records[0]?.extension).toBe(first.records[0]?.extension);
		expect(second.key).toBe(first.key);

		first.release();
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(globalThis.__presetPoolDisposed).toBe(false);

		second.release();
		// Not retired: the generation stays mounted for the next session.
		const third = await acquirePreset(runtime, "preset", ROWS, options);
		expect(third.records[0]?.extension).toBe(first.records[0]?.extension);
		third.release();
	});

	test("retires a changed definition and disposes it after the last release", async () => {
		const options = optionsWith("export default function (pi) { pi.effect(() => { __MARK__; }); }");
		const first = await acquirePreset(runtime, "preset", ROWS, options);
		first.release();

		const changed: PresetPluginRow[] = [{ name: "pkg", config: { shifted: true } }];
		const second = await acquirePreset(runtime, "preset", changed, options);
		expect(second.records[0]?.extension).not.toBe(first.records[0]?.extension);
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(globalThis.__presetPoolDisposed).toBe(true);
		second.release();
	});
});
