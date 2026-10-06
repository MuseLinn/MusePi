import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { enablementAllowsPath, readEnablementCondition } from "./enablement-manifest";

/**
 * A condition is how a plugin says "not in this configuration" — a browser
 * plugin in a headless install, a desktop-only panel in a terminal session. The
 * load path has to honour it before the plugin's code runs, and a plugin it
 * keeps out must not be reported as an error, because the condition holding is
 * not a failure.
 *
 * The condition lives in the manifest rather than in a setting, so these cases
 * read it the way the loader does: from the package the entry file belongs to.
 */
async function pluginFixture(when?: unknown): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), "enablement-"));
	await Bun.write(
		path.join(dir, "package.json"),
		JSON.stringify({ name: "gated-plugin", version: "1.0.0", musepi: when === undefined ? {} : { when } }),
	);
	await Bun.write(path.join(dir, "index.ts"), "export default () => {}");
	return dir;
}

describe("readEnablementCondition", () => {
	it("reads a condition that names a predicate with no argument", async () => {
		const dir = await pluginFixture("lspEnabled");
		try {
			expect(await readEnablementCondition(dir)).toEqual({ condition: "lspEnabled" });
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("reads a condition that carries an argument", async () => {
		// The shape `profileIs` needs: a predicate name plus the value it
		// compares against.
		const dir = await pluginFixture({ profileIs: "desktop" });
		try {
			expect(await readEnablementCondition(path.join(dir, "index.ts"))).toEqual({
				condition: "profileIs",
				argument: "desktop",
			});
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("finds the manifest from an entry file, not only from the directory", async () => {
		// The loader hands over entry files. Reading the condition only from a
		// directory would silently gate nothing.
		const dir = await pluginFixture("macOS");
		const nested = path.join(dir, "src");
		await mkdir(nested, { recursive: true });
		await Bun.write(path.join(nested, "entry.ts"), "export default () => {}");
		try {
			expect(await readEnablementCondition(path.join(nested, "entry.ts"))).toEqual({ condition: "macOS" });
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("reads no condition from a manifest that declares none", async () => {
		const dir = await pluginFixture(undefined);
		try {
			expect(await readEnablementCondition(dir)).toBeUndefined();
			expect(await enablementAllowsPath(dir)).toBe(true);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("reads no condition from a shape it does not understand", async () => {
		// A manifest that gets this wrong should load rather than disappear. Two
		// conditions, or a number, or an empty string — all malformed, all
		// reported, all read as absent.
		for (const malformed of [{ a: "x", b: "y" }, 42, ["lspEnabled"], ""]) {
			const dir = await pluginFixture(malformed);
			try {
				expect(await readEnablementCondition(dir)).toBeUndefined();
				expect(await enablementAllowsPath(dir)).toBe(true);
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		}
	});

	it("loads a plugin naming a condition this build does not register", async () => {
		// Gating a plugin off over a name this build does not know would disable
		// something rather than protect it. The unknown name is warned about, and
		// the plugin loads.
		const dir = await pluginFixture("someConditionFromANewerBuild");
		try {
			expect(await enablementAllowsPath(dir)).toBe(true);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("gates a plugin on the platform it is running on", async () => {
		// The one condition decidable without configuration, so this asserts the
		// gate actually closes rather than only that it reads.
		const macDir = await pluginFixture("macOS");
		const linuxDir = await pluginFixture({ profileIs: "a-profile-this-process-is-not" });
		try {
			expect(await enablementAllowsPath(macDir)).toBe(process.platform === "darwin");
			expect(await enablementAllowsPath(linuxDir)).toBe(false);
		} finally {
			await rm(macDir, { recursive: true, force: true });
			await rm(linuxDir, { recursive: true, force: true });
		}
	});
});
