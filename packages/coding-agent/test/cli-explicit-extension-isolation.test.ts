import { afterEach, beforeEach, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { symlink, unlink } from "node:fs/promises";
import { AuthStorage } from "@musepi/pi-ai";
import { parseArgs } from "@musepi/pi-coding-agent/cli/args";
import { ModelRegistry } from "@musepi/pi-coding-agent/config/model-registry";
import { Settings } from "@musepi/pi-coding-agent/config/settings";
import { buildSessionOptions } from "@musepi/pi-coding-agent/main";
import { loadSessionExtensions } from "@musepi/pi-coding-agent/sdk";
import { SessionManager } from "@musepi/pi-coding-agent/session/session-manager";
import { EventBus } from "@musepi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@musepi/pi-utils";

let tempDir: TempDir;
let authStorage: AuthStorage;

beforeEach(async () => {
	tempDir = await TempDir.create("@cli-explicit-extension-isolation-");
	authStorage = await AuthStorage.create(tempDir.join("auth.db"));
});

afterEach(async () => {
	authStorage.close();
	await tempDir.remove();
});

test("buildSessionOptions retains explicit extensions and hooks under --no-extensions", async () => {
	const extensionPath = tempDir.join("extension-package");
	const hookPath = tempDir.join("hook.ts");
	const parsed = parseArgs(["--no-extensions", "--extension", extensionPath, "--hook", hookPath]);
	const settings = Settings.isolated();
	const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));

	const options = await buildSessionOptions(parsed, [], SessionManager.inMemory(), modelRegistry, settings);

	expect(options.disableExtensionDiscovery).toBe(true);
	expect(options.additionalExtensionPaths).toEqual([extensionPath, hookPath]);
});

test("buildSessionOptions uses trusted extensions as the exact module allowlist", async () => {
	const trustedPath = tempDir.join("trusted.ts");
	await Bun.write(trustedPath, "export default function () {}");
	const parsed = parseArgs(["--trusted-extension", trustedPath]);
	const settings = Settings.isolated();
	const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));

	const options = await buildSessionOptions(parsed, [], SessionManager.inMemory(), modelRegistry, settings);

	expect(options.disableExtensionDiscovery).toBe(true);
	expect(options.additionalExtensionPaths).toEqual([realpathSync.native(trustedPath)]);
});

test("trusted file symlinks cannot be retargeted to expand a directory", async () => {
	const trustedTarget = tempDir.join("trusted-target.ts");
	const replacementDir = tempDir.join("replacement");
	const trustedLink = tempDir.join("trusted.ts");
	await Bun.write(trustedTarget, "export default function () {}");
	await Bun.write(`${replacementDir}/ambient.ts`, "export default function () {}");
	await symlink(trustedTarget, trustedLink);

	const parsed = parseArgs(["--trusted-extension", trustedLink]);
	const settings = Settings.isolated();
	const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
	const options = await buildSessionOptions(parsed, [], SessionManager.inMemory(), modelRegistry, settings);

	await unlink(trustedLink);
	await symlink(replacementDir, trustedLink);
	const result = await loadSessionExtensions(options, tempDir.path(), settings, new EventBus());

	expect(result.errors).toEqual([]);
	expect(result.extensions.map(extension => extension.resolvedPath)).toEqual([realpathSync.native(trustedTarget)]);
});

test("buildSessionOptions rejects trusted extension directories", async () => {
	const parsed = parseArgs(["--trusted-extension", tempDir.path()]);
	const settings = Settings.isolated();
	const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));

	await expect(buildSessionOptions(parsed, [], SessionManager.inMemory(), modelRegistry, settings)).rejects.toThrow(
		/module file, not a directory/,
	);
});
