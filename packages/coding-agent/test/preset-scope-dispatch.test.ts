/**
 * Preset scope dispatch — a preset generation's instance listeners must only
 * reach sessions that joined that preset.
 *
 * dsh mounts a preset once and tags its listeners with the preset scope; the
 * carrier admits them only for agents under that preset. Without the tag, a
 * session sharing an event bus with a preset session would receive the preset
 * plugin's events even though it never selected that preset.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { ExtensionRuntime } from "@musepi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner, emitSessionStartEvent } from "@musepi/pi-coding-agent/extensibility/extensions/runner";
import { mountPlugin } from "@musepi/pi-coding-agent/extensibility/plugins/runtime/mount";
import { SessionManager } from "@musepi/pi-coding-agent/session/session-manager";
import { TempDir } from "@musepi/pi-utils";
import { EventBus } from "../src/utils/event-bus";

describe("preset scope dispatch", () => {
	let tempDir: TempDir;

	beforeEach(() => {
		tempDir = TempDir.createSync("@preset-scope-");
	});

	it("delivers a preset plugin's instance listeners only to sessions that joined the preset", async () => {
		let calls = 0;
		const entry = path.join(tempDir.path(), "preset-ext.ts");
		fs.writeFileSync(
			entry,
			`export default function (pi: any) {
				pi.on("agent_end", () => { (globalThis as any).__presetCalls += 1; });
			}`,
		);
		(globalThis as any).__presetCalls = 0;

		const runtime = new ExtensionRuntime();
		const presetKey = {};
		const mounted = await mountPlugin({
			entryPath: entry,
			cwd: tempDir.path(),
			eventBus: new EventBus(),
			runtime,
			readConfig: async () => ({ fields: [], values: {} }),
			scopeTag: presetKey,
		});
		if (!mounted.ok) throw new Error(mounted.message);

		const joined = new ExtensionRunner(
			[mounted.extension],
			runtime,
			tempDir.path(),
			SessionManager.inMemory(),
			null as never,
		);
		joined.setPresetScopeKey(presetKey);
		const other = new ExtensionRunner(
			[mounted.extension],
			runtime,
			tempDir.path(),
			SessionManager.inMemory(),
			null as never,
		);
		await emitSessionStartEvent(joined);
		await emitSessionStartEvent(other);

		await joined.emit({ type: "agent_end", messages: [] });
		calls = (globalThis as any).__presetCalls;
		expect(calls).toBe(1);

		// The other session has no preset key, so the preset listener is filtered
		// out even though both dispatch on the same bus.
		await other.emit({ type: "agent_end", messages: [] });
		expect((globalThis as any).__presetCalls).toBe(1);
		tempDir.removeSync();
	});
});
