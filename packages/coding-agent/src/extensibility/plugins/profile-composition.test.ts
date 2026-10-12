/**
 * The four-layer assembly path, end to end on real files:
 * profile manifest → bundle patch files → layer stack → composition.
 *
 * DSH's distribution model is the thing under test: a profile LISTS the bundles
 * it stacks, a bundle is a package whose `cordis.patch.yml` inserts rows, and a
 * profile's own patch can reconfigure one row a bundle inserted without editing
 * that bundle. Nothing here mocks the filesystem or the resolver — a temp
 * profile with a real manifest and real patch files exercises the same path a
 * person's profile does.
 *
 * The behaviours pinned are the ones that make the model usable rather than
 * merely parseable: the profile's override wins over the bundle's row, a typo
 * is reported instead of applied to the wrong row, and `!!js` conditions are
 * reported as unevaluated rather than being run or silently read as "enabled".
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { applyDshProfile, mountableRows } from "./dsh-apply";
import { ensureProfileCompositionExample, readProfileComposition, resolveBundleDirs } from "./profile-composition";

let home: string;
let profileDir: string;
let bundleDir: string;

beforeAll(() => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "auth-hub-profile-"));
	profileDir = path.join(home, ".musepi", "profiles", "desktop");
	bundleDir = path.join(profileDir, "node_modules", "@demo", "schedule-bundle");
	fs.mkdirSync(bundleDir, { recursive: true });
	fs.mkdirSync(path.join(home, ".musepi", "plugins", "node_modules"), { recursive: true });
});

afterAll(() => {
	fs.rmSync(home, { recursive: true, force: true });
});

function write(file: string, content: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content, "utf8");
}

describe("profile composition (bundle layer stack)", () => {
	it("reads a profile's bundle list and composes its rows, then applies the profile's override", async () => {
		write(
			path.join(profileDir, "package.json"),
			JSON.stringify({
				name: "desktop",
				dsh: { profile: { bundles: ["@demo/schedule-bundle"] } },
			}),
		);
		write(
			path.join(bundleDir, "package.json"),
			JSON.stringify({
				name: "@demo/schedule-bundle",
				dsh: { bundle: { patch: "./cordis.patch.yml" } },
			}),
		);
		write(
			path.join(bundleDir, "cordis.patch.yml"),
			[
				"- insert:",
				"    - id: schedule",
				"      name: '@demo/plugin-schedule'",
				"      config:",
				"        interval: daily",
				"    - id: time-context",
				"      name: '@demo/plugin-time-context'",
				"",
			].join("\n"),
		);
		// The profile reconfigures ONE row the bundle inserted — the whole point
		// of a row-addressed layer model.
		write(
			path.join(profileDir, "cordis.patch.yml"),
			["- id: schedule", "  config:", "    interval: hourly", ""].join("\n"),
		);

		const note = await readProfileComposition("desktop", home);
		expect(note.kind).toBe("ok");
		if (note.kind !== "ok") throw new Error("profile should declare a composition");

		const dirs = await resolveBundleDirs(note.composition.bundles, note.composition.dir, home);
		expect(dirs.map(d => d.bundle)).toEqual(["@demo/schedule-bundle"]);

		const application = await applyDshProfile(
			{
				bundleDirs: dirs.map(d => d.dir),
				...(note.composition.profilePatchPath ? { profilePatchPath: note.composition.profilePatchPath } : {}),
			},
			profileDir,
			home,
		);

		// Both bundle rows compose, in declaration order.
		expect(application.composition.rows.map(r => r.id)).toEqual(["schedule", "time-context"]);
		// The profile's patch replaced that row's config — and only that row's.
		expect(application.composition.rows[0]?.config).toEqual({ interval: "hourly" });
		expect(application.composition.rows[1]?.config).toBeUndefined();
		// A row's layers say the profile contributed to it and not to the other.
		expect(application.composition.rows[0]?.layers).toEqual(["@demo/schedule-bundle", "profile"]);
		expect(application.composition.rows[1]?.layers).toEqual(["@demo/schedule-bundle"]);
	});

	it("evaluates a !!js condition so the row settles instead of staying unknown", async () => {
		write(
			path.join(bundleDir, "cordis.patch.yml"),
			[
				"- insert:",
				"    - id: win-only",
				"      name: '@demo/plugin-win'",
				"      disabled: !!js process.platform === 'win32'",
				"",
			].join("\n"),
		);
		fs.rmSync(path.join(profileDir, "cordis.patch.yml"), { force: true });

		const application = await applyDshProfile({ bundleDirs: [bundleDir] }, profileDir, home);

		// The condition is computed against the host facts: `disabled` carries
		// exactly what the expression evaluated to.
		expect(application.composition.conditionalRows).toEqual([]);
		expect(application.composition.rows[0]?.disabled).toBe(process.platform === "win32");
	});

	it("keeps a row conditional when the expression cannot be evaluated", async () => {
		write(
			path.join(bundleDir, "cordis.patch.yml"),
			[
				"- insert:",
				"    - id: mystery",
				"      name: '@demo/plugin-mystery'",
				"      disabled: !!js totallyUnknownSwitch === true",
				"",
			].join("\n"),
		);
		fs.rmSync(path.join(profileDir, "cordis.patch.yml"), { force: true });

		const application = await applyDshProfile({ bundleDirs: [bundleDir] }, profileDir, home);

		// Unresolvable is still unknown, and still reported as such.
		expect(application.composition.conditionalRows).toEqual(["mystery"]);
		expect(application.composition.rows[0]?.disabled).toBeUndefined();
	});

	it("reports a bundle row whose plugin is not installed, without failing the rest", async () => {
		write(
			path.join(bundleDir, "cordis.patch.yml"),
			[
				"- insert:",
				"    - id: present",
				"      name: '@demo/plugin-missing'",
				"    - id: also-missing",
				"      name: '@demo/plugin-absent'",
				"",
			].join("\n"),
		);

		const application = await applyDshProfile({ bundleDirs: [bundleDir] }, profileDir, home);

		// Both rows compose — the composition is about what the patch said.
		expect(application.composition.rows.map(r => r.id)).toEqual(["present", "also-missing"]);
		// Both plugins are absent here, reported per row rather than thrown.
		expect(application.unresolvedPlugins.map(e => e.id)).toEqual(["present", "also-missing"]);
		// Nothing mountable: a row whose plugin is not installed cannot mount.
		expect(mountableRows(application)).toEqual([]);
	});

	it("reads a profile with no composition as an ordinary state, not a failure", async () => {
		const note = await readProfileComposition("nonexistent", home);

		expect(note.kind).toBe("no-manifest");
	});
});

describe("ensureProfileCompositionExample (post-upgrade discoverability)", () => {
	it("writes a manifest and a commented patch into a profile that has neither", async () => {
		const dir = path.join(home, ".musepi", "profiles", "fresh");

		expect(await ensureProfileCompositionExample(dir)).toBe("written");

		// The skeleton parses as a profile declaration (empty bundle list), so
		// the composition surface reads it rather than treating it as broken.
		const note = await readProfileComposition("fresh", home);
		expect(note.kind).toBe("ok");
		if (note.kind !== "ok") throw new Error("example should be readable");
		expect(note.composition.bundles).toEqual([]);
		// The patch file exists and explains itself by comment.
		expect(fs.readFileSync(path.join(dir, "cordis.patch.yml"), "utf8")).toContain("#- id: some-row");
	});

	it("never overwrites a manifest the person already has", async () => {
		const dir = path.join(home, ".musepi", "profiles", "mine");
		fs.mkdirSync(dir, { recursive: true });
		const mine = JSON.stringify({ name: "mine", dsh: { profile: { bundles: ["@demo/x"] } } });
		fs.writeFileSync(path.join(dir, "package.json"), mine, "utf8");

		expect(await ensureProfileCompositionExample(dir)).toBe("skipped");
		// Byte-identical: the declaration is the person's, not ours.
		expect(fs.readFileSync(path.join(dir, "package.json"), "utf8")).toBe(mine);
	});

	it("writes no manifest over a profile that already has a patch file", async () => {
		const dir = path.join(home, ".musepi", "profiles", "patched");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "cordis.patch.yml"), "- id: mine\n  disabled: true\n", "utf8");

		expect(await ensureProfileCompositionExample(dir)).toBe("skipped");
		expect(fs.existsSync(path.join(dir, "package.json"))).toBe(false);
	});
});
