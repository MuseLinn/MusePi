/**
 * Guards the build manifest the daemon assembles every plugin surface from.
 *
 * The failure this pins is silent by construction: a surface missing from the
 * manifest never mounts, and nothing errors. `browser.host` vanished this way
 * (a plugin's second surface replaced the first), so the test drives the real
 * `index.ts` sources of the shipped plugins instead of a hand-written fixture.
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { type ManifestDeclaration, mergeDeclarations, parseDeclaredSlots } from "../scripts/plugin-manifest";

const appRoot = path.resolve(import.meta.dir, "..");

async function declare(pluginDir: string): Promise<ManifestDeclaration[]> {
	const root = path.join(appRoot, pluginDir);
	const source = await Bun.file(path.join(root, "index.ts")).text();
	const declared = parseDeclaredSlots(source);
	const surfaces = [...new Set(declared.map(row => row.moduleUrl))];
	let merged: ManifestDeclaration[] = [];
	for (const moduleUrl of surfaces) {
		const relative = moduleUrl.replace(/^\.\//, "");
		merged = mergeDeclarations(merged, declared, {
			relative,
			file: `${path.basename(pluginDir)}-${path.basename(relative, ".tsx")}.js`,
		});
	}
	return merged;
}

describe("plugin build manifest", () => {
	it("keeps every surface of a plugin that declares more than one", async () => {
		const rows = await declare("src/plugins/browser-ui");
		// The persistent host and the pane are separate surfaces of one plugin;
		// the host is what puts a <webview> on screen at all.
		expect(rows.map(row => row.slot).sort()).toEqual(["browser.host", "panel.tab.browser"]);
		expect(rows.find(row => row.slot === "browser.host")?.file).toBe("browser-ui-host.js");
	});

	it("carries availability through, so an on-demand tab stays off the rail", async () => {
		const rows = await declare("../../packages/coding-agent/src/plugins/workspace/compaction-summary");
		expect(rows).toEqual([
			{
				slot: "panel.tab.compaction",
				file: "compaction-summary-summary-panel.js",
				label: "压缩摘要",
				order: 20,
				availability: "on-demand",
			},
		]);
	});

	it("keeps one dock entry per pill, with its id and order", async () => {
		const rows = await declare("../../packages/coding-agent/src/plugins/style/stats-pills");
		expect(
			rows.filter(row => row.slot === "conversation.composer.dock").map(row => ({ id: row.id, order: row.order })),
		).toEqual([
			{ id: "activity", order: 0 },
			{ id: "usage", order: 1 },
		]);
	});

	it("drops a declaration whose module does not belong to the surface being built", () => {
		const declared = parseDeclaredSlots(
			`ctx.slots.register({ slot: "a.one", moduleUrl: "./one.tsx" });\n` +
				`ctx.slots.register({ slot: "a.two", moduleUrl: "./two.tsx" });`,
		);
		const merged = mergeDeclarations(undefined, declared, { relative: "two.tsx", file: "two.js" });
		expect(merged.map(row => row.slot)).toEqual(["a.two"]);
	});
});
