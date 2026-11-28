import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listDshProfiles } from "../src/discovery/dsh-plugins";

/** Build a DSH home with one profile and the packages the test declares. */
function homeWith(
	profile: string,
	manifest: unknown,
	packages: Record<string, unknown> = {},
): { home: string; cleanup: () => void } {
	const home = mkdtempSync(join(tmpdir(), "dsh-discovery-"));
	const dir = join(home, "profiles", profile);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
	for (const [name, entry] of Object.entries(packages)) {
		const pkgDir = join(dir, "node_modules", name);
		mkdirSync(pkgDir, { recursive: true });
		writeFileSync(join(pkgDir, "package.json"), JSON.stringify(entry));
	}
	return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

describe("dsh plugin discovery", () => {
	test("lists a profile's declared bundles with their installed state", async () => {
		const { home, cleanup } = homeWith(
			"desktop",
			{ dsh: { profile: { bundles: ["alpha", "beta"] } }, dependencies: { alpha: "^1.2.3" } },
			{ alpha: { name: "alpha", dsh: { bundle: { patch: "./cordis.patch.yml" }, client: { platform: "web" } } } },
		);
		try {
			const profiles = await listDshProfiles(home);
			expect(profiles).toHaveLength(1);
			const bundles = profiles[0]?.bundles ?? [];
			expect(bundles.map(b => b.name)).toEqual(["alpha", "beta"]);

			const alpha = bundles[0];
			expect(alpha?.dir).toBeDefined();
			expect(alpha?.bundlePatch).toBe("./cordis.patch.yml");
			expect(alpha?.hasClient).toBe(true);
			expect(alpha?.version).toBe("^1.2.3");

			// Declared by the profile but absent from node_modules: reported, not hidden.
			expect(bundles[1]?.name).toBe("beta");
			expect(bundles[1]?.dir).toBeUndefined();
		} finally {
			cleanup();
		}
	});

	test("ignores a profile that declares no bundles", async () => {
		const { home, cleanup } = homeWith("empty", { name: "dsh-profile-empty" });
		try {
			expect(await listDshProfiles(home)).toHaveLength(0);
		} finally {
			cleanup();
		}
	});

	test("returns nothing for a home with no profiles directory", async () => {
		const home = mkdtempSync(join(tmpdir(), "dsh-none-"));
		try {
			expect(await listDshProfiles(home)).toEqual([]);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("tolerates an unreadable package manifest", async () => {
		const { home, cleanup } = homeWith("p", { dsh: { profile: { bundles: ["broken"] } } }, {});
		try {
			const dir = join(home, "profiles", "p", "node_modules", "broken");
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "package.json"), "{ not json");
			const bundles = (await listDshProfiles(home))[0]?.bundles ?? [];
			expect(bundles).toHaveLength(1);
			expect(bundles[0]?.dir).toBeUndefined();
		} finally {
			cleanup();
		}
	});

	test("skips declarations that are not bundle names", async () => {
		const { home, cleanup } = homeWith("p", {
			dsh: { profile: { bundles: ["ok", 42, "", null] } },
		});
		try {
			expect((await listDshProfiles(home))[0]?.bundles.map(b => b.name)).toEqual(["ok"]);
		} finally {
			cleanup();
		}
	});
});
