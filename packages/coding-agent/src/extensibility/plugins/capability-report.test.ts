import { describe, expect, it } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describePluginCapability } from "./capability-report";
import type { InstalledPlugin } from "./types";

/**
 * The capability report is what separates "the package manager wrote it" from
 * "this host can run it". A package built for another harness installs cleanly
 * and then fails to load, so the verdict is the only thing standing between a
 * person and a plugin that silently does nothing.
 *
 * Each fixture writes a real `package.json` and a real entry file, because the
 * probe reads those from disk; a fixture that only set a field on the object
 * would not exercise the reading path.
 */

async function writeFixture(files: Record<string, string>): Promise<{ dir: string; plugin: InstalledPlugin }> {
	const dir = await mkdtemp(path.join(tmpdir(), "plugin-capability-"));
	for (const [relative, contents] of Object.entries(files)) {
		const target = path.join(dir, relative);
		await Bun.write(target, contents);
	}
	return {
		dir,
		plugin: {
			name: "acme-plugin",
			version: "1.0.0",
			path: dir,
			manifest: { version: "1.0.0" },
			enabledFeatures: null,
			enabled: true,
		},
	};
}

describe("describePluginCapability", () => {
	it("reports a plugin whose dependencies this host provides as runnable", async () => {
		const { plugin } = await writeFixture({
			"package.json": JSON.stringify({
				name: "acme-plugin",
				version: "1.0.0",
				musepi: { extensions: ["index.ts"] },
				peerDependencies: { "@musepi/pi-utils": "^1.0.0", react: "^19.0.0" },
			}),
			"index.ts": "export default () => {}",
		});

		const report = await describePluginCapability(plugin);
		expect(report.verdict).toBe("runnable");
		expect(report.missing).toEqual([]);
	});

	it("names the foreign runtime packages that make a plugin unloadable", async () => {
		// The shape a plugin built for another harness actually has: its peer
		// dependencies point at that harness's packages, none of which exist here.
		const { plugin } = await writeFixture({
			"package.json": JSON.stringify({
				name: "foreign-plugin",
				version: "1.0.0",
				musepi: { extensions: ["index.ts"] },
				peerDependencies: {
					"@deepseek-ai/dsh-client-ui-sidebar-right": "^0.2.0",
					"@deepseek-ai/dsh-agent": "^0.2.0",
					"@musepi/pi-utils": "^1.0.0",
				},
			}),
			"index.ts": "export default () => {}",
		});

		const report = await describePluginCapability(plugin);
		// Installed, but not loadable here — and the reason is named rather than
		// left for the person to meet as a load error.
		expect(report.verdict).toBe("incompatible");
		expect(report.missing).toContain("@deepseek-ai/dsh-client-ui-sidebar-right");
		expect(report.missing).toContain("@deepseek-ai/dsh-agent");
		// The dependency this host does provide is not reported as missing.
		expect(report.missing).not.toContain("@musepi/pi-utils");
	});

	it("reports a component whose slot this host does not mount as partial, not broken", async () => {
		// A plugin that loads but whose card has nowhere to appear is a different
		// problem from one that cannot load, and the verdict says so.
		const { plugin } = await writeFixture({
			"package.json": JSON.stringify({
				name: "other-harness-ui",
				version: "1.0.0",
				musepi: { extensions: ["index.ts"] },
			}),
			"index.ts": `pi.slots.register({ name: "otherhost.some.slot" }, () => null);`,
		});

		const report = await describePluginCapability(plugin);
		expect(report.verdict).toBe("partial");
		expect(report.unhostedSlots).toContain("otherhost.some.slot");
		expect(report.missing).toEqual([]);
	});

	it("accepts a slot this host declares, including a prefixed family", async () => {
		const { plugin } = await writeFixture({
			"package.json": JSON.stringify({
				name: "sidebar-card",
				version: "1.0.0",
				musepi: { extensions: ["index.ts"] },
			}),
			"index.ts": `pi.registerComponent({ slot: "panel.tab.mine", moduleUrl: "./ui.tsx" });`,
		});

		const report = await describePluginCapability(plugin);
		// `panel.tab.` is a hosted family, so this card has a mount site.
		expect(report.unhostedSlots).toEqual([]);
		expect(report.verdict).toBe("runnable");
	});

	it("reports a declared entry that is not on disk as load-blocking", async () => {
		// A package that publishes an entry it cannot load: the dependency list
		// says nothing is missing, so only the entry check catches this.
		const { plugin } = await writeFixture({
			"package.json": JSON.stringify({
				name: "broken-plugin",
				version: "1.0.0",
				musepi: { extensions: ["missing.ts"] },
			}),
		});

		const report = await describePluginCapability(plugin);
		expect(report.verdict).toBe("incompatible");
		expect(report.missing.join(" ")).toContain("missing.ts");
	});
});
