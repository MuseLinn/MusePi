/**
 * Host extension mode registry — a preset declared by an extension is listable
 * without a live session (dsh's host-level presets).
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { listHostExtensionModes } from "@musepi/pi-coding-agent/extensibility/extensions/host-modes";
import { disposePluginPrimitives } from "@musepi/pi-coding-agent/extensibility/plugins/runtime/cordis-primitives";
import { loadSessionPluginsCached } from "@musepi/pi-coding-agent/extensibility/plugins/runtime/session-loader";
import { TempDir } from "@musepi/pi-utils";
import { EventBus } from "../src/utils/event-bus";

describe("host extension modes", () => {
	test("records a mounted extension's modes and forgets them on disposal", async () => {
		const dir = TempDir.createSync("@host-modes-");
		const entry = path.join(dir.path(), "mode-ext.ts");
		fs.writeFileSync(
			entry,
			'export default function (pi: any) { pi.registerMode({ id: "host-probe-mode", label: "Probe" }); }',
		);

		const loaded = await loadSessionPluginsCached([entry], dir.path(), new EventBus());
		expect(loaded.result.extensions[0]?.modes.map(mode => mode.id)).toEqual(["host-probe-mode"]);
		expect(listHostExtensionModes().some(entry => entry.mode.id === "host-probe-mode")).toBe(true);
		expect(listHostExtensionModes().find(entry => entry.mode.id === "host-probe-mode")?.extensionId).toBe(
			loaded.result.extensions[0]?.resolvedPath,
		);

		await disposePluginPrimitives(loaded.result.extensions[0]!);
		loaded.release();
		expect(listHostExtensionModes().some(entry => entry.mode.id === "host-probe-mode")).toBe(false);
		dir.removeSync();
	});
});
