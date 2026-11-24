/**
 * User-created extension removal contract.
 *
 * The capability center used to render a user's own extension as an ordinary
 * module row with only an enable switch: the directory existed, but no RPC
 * owned deleting it (`plugins.uninstall` only serves the plugins tree). The
 * fix follows dsh's fact split: the Host marks a row `removable`, the GUI only
 * renders what that fact allows, and the removal RPC re-checks the same fact
 * and managed root before touching the filesystem.
 *
 * A regression means: a user's extension has no delete affordance, a bundled
 * or externally configured module is offered one, or removal leaves the
 * `disabledExtensions` key behind so the next list shows a ghost row.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@musepi/pi-coding-agent/config/settings";
import { ExtensionService } from "../../src/daemon/services/extension-service";
import { isolateAgentDirForTest, restoreAgentDirForTest } from "../helpers/isolate-agent-dir";

type Listed = {
	extensions: Array<{
		id: string;
		kind: string;
		name: string;
		path: string;
		source: { level: "user" | "project" | "native" };
		removable?: boolean;
		removeBlockedReason?: string;
	}>;
};

const USER_EXTENSION = "gradient-wallpaper";

async function writeExtension(dir: string, name: string): Promise<void> {
	await fs.mkdir(path.join(dir, name), { recursive: true });
	await Bun.write(path.join(dir, name, "index.ts"), "export default function (): void { /* user extension */ }\n");
}

describe("extensions.remove (user-owned module removal)", () => {
	let agentDir: string;
	let cwd: string;
	let settings: Settings;
	let removedPaths: string[];
	let broadcasts: number;
	let service: ExtensionService;

	beforeAll(async () => {
		agentDir = await isolateAgentDirForTest("extension-remove-");
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "extension-remove-cwd-"));
		settings = Settings.isolated();
		settings.set("disabledExtensions", [USER_EXTENSION] as never);
		await writeExtension(path.join(agentDir, "extensions"), USER_EXTENSION);
		await writeExtension(path.join(agentDir, "extensions"), "kept-by-user");
		// A configured path outside the managed roots is listed but not removable.
		const outside = path.join(cwd, "outside-extension.ts");
		await Bun.write(outside, "export default function (): void {}\n");
		await Bun.write(path.join(agentDir, "settings.json"), JSON.stringify({ extensions: [outside] }));
		removedPaths = [];
		broadcasts = 0;
		service = new ExtensionService({
			settings: () => settings,
			ensureRegistry: async () => ({}),
			cwd: () => cwd,
			webUrl: () => null,
			webPortFile: () => path.join(agentDir, "web.port"),
			applyLive: async target => {
				removedPaths.push(...(target.remove ?? []));
				return { errors: [] };
			},
			onChanged: () => {
				broadcasts += 1;
			},
		});
	}, 30_000);

	afterAll(async () => {
		await fs.rm(cwd, { recursive: true, force: true });
		await restoreAgentDirForTest(agentDir);
	}, 30_000);

	it("lists the user module as removable and the configured external path as not", async () => {
		const { extensions } = (await service.list()) as unknown as Listed;
		const userRow = extensions.find(entry => entry.name === USER_EXTENSION);
		expect(userRow).toBeDefined();
		expect(userRow?.removable).toBe(true);

		const outside = extensions.find(entry => entry.name === "outside-extension");
		expect(outside).toBeDefined();
		expect(outside?.removable).toBe(false);
		expect(outside?.removeBlockedReason).toBe("unmanaged-path");
	});

	it("removes the directory, detaches live sessions, and clears enablement residue", async () => {
		const target = path.join(agentDir, "extensions", USER_EXTENSION);
		const result = await service.removeExtension({ id: USER_EXTENSION });
		expect(result).toEqual({ ok: true, name: USER_EXTENSION, path: target });

		await expect(fs.stat(target)).rejects.toMatchObject({ code: "ENOENT" });
		expect((settings.get("disabledExtensions") ?? []) as string[]).not.toContain(USER_EXTENSION);
		expect(removedPaths).toContain(path.join(target, "index.ts"));
		expect(broadcasts).toBeGreaterThan(0);

		const { extensions } = (await service.list()) as unknown as Listed;
		expect(extensions.some(entry => entry.name === USER_EXTENSION)).toBe(false);
		// The sibling user extension and the external path stay untouched.
		await expect(fs.stat(path.join(agentDir, "extensions", "kept-by-user"))).resolves.toBeDefined();
	});

	it("refuses a row whose path is outside a managed extensions root", async () => {
		const outside = ((await service.list()) as unknown as Listed).extensions.find(
			entry => entry.name === "outside-extension",
		);
		expect(outside).toBeDefined();
		await expect(service.removeExtension({ id: outside!.id })).rejects.toThrow("unmanaged-path");
	});

	it("refuses a non-module row", async () => {
		const { extensions } = (await service.list()) as unknown as Listed;
		const other = extensions.find(entry => entry.kind !== "plugin-module" && entry.kind !== "extension-module");
		if (other) await expect(service.removeExtension({ id: other.id })).rejects.toThrow("not an extension module");
	});

	it("never marks a bundled/native module removable", async () => {
		const { extensions } = (await service.list()) as unknown as Listed;
		for (const entry of extensions) {
			if (entry.source.level !== "native") continue;
			if (entry.kind !== "plugin-module" && entry.kind !== "extension-module") continue;
			expect(entry.removable).toBe(false);
			// Native rows are also annotated by the builtin registry, so either
			// fact may be the first reason; both mean "ships with the client".
			expect(entry.removeBlockedReason === "builtin" || entry.removeBlockedReason === "bundled").toBe(true);
		}
	});
});
