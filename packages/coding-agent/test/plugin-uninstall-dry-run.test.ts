/**
 * Regression tests for `omp plugin uninstall <plugin> --dry-run` (#8178).
 *
 * `--dry-run` must be non-mutating: it reports what would be removed and
 * leaves the installed plugin list untouched. Before the fix, `handleUninstall`
 * dropped the parsed `dryRun` flag and unconditionally called the removal
 * methods, so a dry-run actually uninstalled the plugin on both the npm and
 * marketplace routes.
 *
 * `flags.json` is set so the renderer takes the JSON branch and avoids the
 * theme (`runPluginCommand` does not initialize the theme on its own).
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { runPluginCommand } from "@musepi/pi-coding-agent/cli/plugin-cli";
import { PluginManager } from "@musepi/pi-coding-agent/extensibility/plugins/manager";
import type { InstalledPluginSummary } from "@musepi/pi-coding-agent/extensibility/plugins/marketplace";
import { MarketplaceManager } from "@musepi/pi-coding-agent/extensibility/plugins/marketplace";

describe("runPluginCommand({ action: 'uninstall', flags: { dryRun } })", () => {
	beforeEach(() => {
		spyOn(console, "log").mockImplementation(() => undefined);
		spyOn(console, "error").mockImplementation(() => undefined);
	});
	afterEach(() => {
		mock.restore();
	});

	test("npm route: --dry-run never calls PluginManager.uninstall", async () => {
		// No marketplace-installed plugins → the name routes down the npm path.
		spyOn(MarketplaceManager.prototype, "listInstalledPlugins").mockResolvedValue([]);
		const npmUninstall = spyOn(PluginManager.prototype, "uninstall").mockResolvedValue(undefined);
		const mktUninstall = spyOn(MarketplaceManager.prototype, "uninstallPlugin").mockResolvedValue(undefined);
		try {
			await runPluginCommand({ action: "uninstall", args: ["zmarketplace"], flags: { dryRun: true, json: true } });
			expect(npmUninstall).not.toHaveBeenCalled();
			expect(mktUninstall).not.toHaveBeenCalled();
		} finally {
			npmUninstall.mockRestore();
			mktUninstall.mockRestore();
		}
	});

	test("marketplace route: --dry-run delegates scope validation without npm removal", async () => {
		const installed: InstalledPluginSummary = {
			id: "hello@local",
			scope: "user",
			entries: [
				{
					scope: "user",
					installPath: "/tmp/hello",
					version: "1.0.0",
					installedAt: new Date().toISOString(),
					lastUpdated: new Date().toISOString(),
				},
			],
		};
		spyOn(MarketplaceManager.prototype, "listInstalledPlugins").mockResolvedValue([installed]);
		const npmUninstall = spyOn(PluginManager.prototype, "uninstall").mockResolvedValue(undefined);
		const mktUninstall = spyOn(MarketplaceManager.prototype, "uninstallPlugin").mockResolvedValue(undefined);
		try {
			await runPluginCommand({ action: "uninstall", args: ["hello@local"], flags: { dryRun: true, json: true } });
			expect(mktUninstall).toHaveBeenCalledTimes(1);
			expect(mktUninstall.mock.calls[0]).toEqual(["hello@local", undefined, { dryRun: true }]);
			expect(npmUninstall).not.toHaveBeenCalled();
		} finally {
			npmUninstall.mockRestore();
			mktUninstall.mockRestore();
		}
	});

	test("without --dry-run the npm route still uninstalls", async () => {
		spyOn(MarketplaceManager.prototype, "listInstalledPlugins").mockResolvedValue([]);
		const npmUninstall = spyOn(PluginManager.prototype, "uninstall").mockResolvedValue(undefined);
		try {
			await runPluginCommand({ action: "uninstall", args: ["zmarketplace"], flags: { json: true } });
			expect(npmUninstall).toHaveBeenCalledTimes(1);
			expect(npmUninstall.mock.calls[0]?.[0]).toBe("zmarketplace");
		} finally {
			npmUninstall.mockRestore();
		}
	});
});
