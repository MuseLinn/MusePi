// MusePi fork: opt-in compat bridge (`musepi.compat.loadPiExtensions`) —
// when enabled, extensions from the legacy pi home (~/.pi/agent/extensions)
// are auto-loaded alongside the MusePi home; off by default.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DefaultPackageManager } from "../src/core/package-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

let fakeHome = "";

vi.mock("node:os", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:os")>();
	return { ...original, homedir: () => fakeHome };
});

function normalizeForMatch(value: string): string {
	return value.replace(/\\/g, "/");
}

describe("compat.loadPiExtensions", () => {
	let tempDir: string;
	let agentDir: string;
	let legacyExtensionPath: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pm-compat-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		fakeHome = join(tempDir, "home");
		agentDir = join(tempDir, "agent");
		const legacyExtensionsDir = join(fakeHome, ".pi", "agent", "extensions");
		mkdirSync(legacyExtensionsDir, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		legacyExtensionPath = join(legacyExtensionsDir, "legacy-ext.ts");
		writeFileSync(legacyExtensionPath, "export default function() {}");
	});

	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(tempDir, { recursive: true, force: true });
	});

	async function resolveExtensionPaths(musepi?: Parameters<typeof SettingsManager.inMemory>[0]): Promise<string[]> {
		const packageManager = new DefaultPackageManager({
			cwd: tempDir,
			agentDir,
			settingsManager: SettingsManager.inMemory(musepi),
		});
		const result = await packageManager.resolve();
		return result.extensions.map((r) => normalizeForMatch(r.path));
	}

	it("does not load legacy pi extensions by default", async () => {
		const paths = await resolveExtensionPaths();
		expect(paths.some((p) => p.endsWith(".pi/agent/extensions/legacy-ext.ts"))).toBe(false);
	});

	it("loads legacy pi extensions when opted in", async () => {
		const paths = await resolveExtensionPaths({ musepi: { compat: { loadPiExtensions: true } } });
		expect(paths.some((p) => p.endsWith(".pi/agent/extensions/legacy-ext.ts"))).toBe(true);
	});
});
