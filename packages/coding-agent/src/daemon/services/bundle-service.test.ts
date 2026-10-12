/**
 * BundleService contract — the daemon read surface over profile composition.
 *
 * What a person needs from this surface, and what is pinned here: a profile
 * that stacks bundles reports the rows it would mount, a row whose plugin is
 * absent reports WHY rather than disappearing, a `!!js` condition is reported
 * as `conditional` (never as enabled or disabled), and a profile that declares
 * nothing is an ordinary state rather than an error.
 *
 * The composition itself is exercised end-to-end in
 * `profile-composition.test.ts`; this covers the service's own contract — the
 * wire shape, the cache, and the states a composition can report.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BundleService } from "./bundle-service";

let home: string;
let profileDir: string;
let bundleDir: string;

function service(profileName = "desktop"): BundleService {
	return new BundleService({
		cwd: () => profileDir,
		home: () => home,
		invalidate: () => {},
		profileName: () => profileName,
	});
}

function write(file: string, content: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content, "utf8");
}

/** Write a profile that stacks one bundle declaring the given rows. */
function profileWith(rows: string[], profilePatch?: string): void {
	write(
		path.join(profileDir, "package.json"),
		JSON.stringify({ name: "test", dsh: { profile: { bundles: ["@demo/bundle"] } } }),
	);
	write(
		path.join(bundleDir, "package.json"),
		JSON.stringify({ name: "@demo/bundle", dsh: { bundle: { patch: "./cordis.patch.yml" } } }),
	);
	write(path.join(bundleDir, "cordis.patch.yml"), `${rows.join("\n")}\n`);
	if (profilePatch) write(path.join(profileDir, "cordis.patch.yml"), profilePatch);
}

beforeEach(() => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-service-"));
	profileDir = path.join(home, ".musepi", "profiles", "desktop");
	bundleDir = path.join(profileDir, "node_modules", "@demo", "bundle");
	fs.mkdirSync(path.join(home, ".musepi", "plugins", "node_modules"), { recursive: true });
});

afterEach(() => {
	fs.rmSync(home, { recursive: true, force: true });
});

describe("BundleService.profile", () => {
	it("reports a profile with no manifest as an ordinary state", async () => {
		// A profile that names no manifest declares no composition — which is
		// most profiles, and must not read as a failure.
		const view = await service("never-created").profile();

		expect(view.declared).toBe("no-manifest");
		expect(view.profile).toBe("never-created");
	});
});

describe("BundleService.composition", () => {
	it("reports an empty stack for a profile that declares nothing", async () => {
		const view = await service().composition();

		expect(view.declared).toBe("no-manifest");
		expect(view.rows).toEqual([]);
		expect(view.bundles).toEqual([]);
		expect(view.unevaluatedExpressions).toBe(0);
	});

	it("reports each composed row with its plugin issue rather than dropping it", async () => {
		profileWith([
			"- insert:",
			"    - id: alpha",
			"      name: '@demo/plugin-alpha'",
			"    - id: beta",
			"      name: '@demo/plugin-beta'",
		]);

		const view = await service().composition();

		expect(view.declared).toBe("ok");
		expect(view.rows.map(r => r.id)).toEqual(["alpha", "beta"]);
		// Both plugins are absent in this temp tree: the row is still reported,
		// with the reason, because "installed but contributes nothing" is the
		// failure mode this surface exists to make visible.
		for (const row of view.rows) {
			expect(row.pluginIssue).toBe("not-installed");
			expect(row.pluginPath).toBeNull();
			expect(row.mountable).toBe(false);
		}
	});

	it("resolves a !!js-conditioned row to a real enablement", async () => {
		profileWith([
			"- insert:",
			"    - id: win-only",
			"      name: '@demo/plugin-win'",
			"      disabled: !!js process.platform === 'win32'",
		]);

		const view = await service().composition();

		// The expression is evaluated, so the row no longer sits permanently
		// undecidable. The patch says "disabled on win32", so on this machine
		// (win32) the row resolves to disabled — exactly what the expression
		// computes, not a guess in either direction.
		expect(view.rows[0]?.state).toBe(process.platform === "win32" ? "disabled" : "enabled");
		expect(view.conditionalRows).toEqual([]);
	});

	it("keeps a row conditional when its expression cannot be evaluated", async () => {
		profileWith([
			"- insert:",
			"    - id: mystery",
			"      name: '@demo/plugin-mystery'",
			"      disabled: !!js totallyUnknownSwitch === true",
		]);

		const view = await service().composition();

		// Unresolvable, so unknown — and reported rather than assumed.
		expect(view.rows[0]?.state).toBe("conditional");
		expect(view.conditionalRows).toEqual(["mystery"]);
	});

	it("shows a plain row as enabled and a disabled one as disabled", async () => {
		profileWith([
			"- insert:",
			"    - id: on",
			"      name: '@demo/plugin-on'",
			"    - id: off",
			"      name: '@demo/plugin-off'",
			"      disabled: true",
		]);

		const view = await service().composition();

		expect(view.rows.find(r => r.id === "on")?.state).toBe("enabled");
		expect(view.rows.find(r => r.id === "off")?.state).toBe("disabled");
	});

	it("reports which layers contributed to a row the profile reconfigured", async () => {
		profileWith(
			["- insert:", "    - id: schedule", "      name: '@demo/plugin-schedule'"],
			["- id: schedule", "  disabled: true", ""].join("\n"),
		);

		const view = await service().composition();

		expect(view.rows[0]?.layers).toEqual(["@demo/bundle", "profile"]);
		expect(view.rows[0]?.state).toBe("disabled");
	});

	it("caches the composition until invalidated", async () => {
		profileWith(["- insert:", "    - id: alpha", "      name: '@demo/plugin-alpha'"]);
		const svc = service();

		const first = await svc.composition();
		expect(first.rows).toHaveLength(1);

		// A second read inside the TTL is the same answer even though disk
		// changed — the cache is what keeps the composition off the hot path.
		write(
			path.join(bundleDir, "cordis.patch.yml"),
			["- insert:", "    - id: beta", "      name: '@demo/plugin-beta'", ""].join("\n"),
		);
		expect((await svc.composition()).rows.map(r => r.id)).toEqual(["alpha"]);

		// Invalidating re-reads, so the edited patch file is picked up without a
		// restart — this is the host watcher's entry point.
		svc.invalidate();
		expect((await svc.composition()).rows.map(r => r.id)).toEqual(["beta"]);
	});
});

describe("BundleService.setRowEnabled (control surface)", () => {
	it("disables a row by writing an override, and reports the composed result", async () => {
		profileWith(["- insert:", "    - id: alpha", "      name: '@demo/plugin-alpha'"]);
		const svc = service();

		const result = await svc.setRowEnabled({ id: "alpha", enabled: false });

		// The answer is the composition's, not the request's.
		expect(result.ok).toBe(true);
		expect(result.state).toBe("disabled");
		// The write landed in the PROFILE's patch file, as an override.
		const patch = fs.readFileSync(path.join(profileDir, "cordis.patch.yml"), "utf8");
		expect(patch).toContain("- id: alpha");
		expect(patch).toContain("disabled: true");
		// The bundle's own patch file is untouched — the profile overrides it.
		expect(fs.readFileSync(path.join(bundleDir, "cordis.patch.yml"), "utf8")).not.toContain("disabled");
	});

	it("re-enables the row on the next toggle without growing the patch", async () => {
		profileWith(["- insert:", "    - id: alpha", "      name: '@demo/plugin-alpha'"]);
		const svc = service();

		await svc.setRowEnabled({ id: "alpha", enabled: false });
		await svc.setRowEnabled({ id: "alpha", enabled: true });

		const patch = fs.readFileSync(path.join(profileDir, "cordis.patch.yml"), "utf8");
		expect(patch.match(/- id: alpha/g)?.length).toBe(1);
		expect(patch).toContain("disabled: false");
		expect((await svc.composition()).rows[0]?.state).toBe("enabled");
	});

	it("refuses a row the composition does not contain", async () => {
		profileWith(["- insert:", "    - id: alpha", "      name: '@demo/plugin-alpha'"]);

		const result = await service().setRowEnabled({ id: "typo", enabled: false });

		expect(result.ok).toBe(false);
		expect(result.error).toContain("typo");
		// Nothing written.
		expect(fs.existsSync(path.join(profileDir, "cordis.patch.yml"))).toBe(false);
	});

	it("evaluates a !!js condition and lets a profile override the result", async () => {
		// The condition now RESOLVES (this machine is not win32, so the row is
		// disabled), and a profile override must win over it — that precedence
		// is the point of layers. Overriding a resolved condition is allowed;
		// only an UNRESOLVABLE one is refused.
		profileWith([
			"- insert:",
			"    - id: win-only",
			"      name: '@demo/plugin-win'",
			"      disabled: !!js process.platform === 'win32'",
		]);

		const svc = service();
		// Resolved from the expression, not left unknown: the patch disables the
		// row on win32, which is this machine.
		const before = await svc.composition();
		expect(before.rows[0]?.state).toBe(process.platform === "win32" ? "disabled" : "enabled");

		// And the profile can still override it.
		const result = await svc.setRowEnabled({ id: "win-only", enabled: true });
		expect(result.ok).toBe(true);
		expect((await svc.composition()).rows[0]?.state).toBe("enabled");
	});

	it("refuses to toggle a row whose expression cannot be evaluated", async () => {
		// An expression naming something unknowable leaves the row unresolved;
		// toggling it would be writing against a state nobody can determine.
		profileWith([
			"- insert:",
			"    - id: mystery",
			"      name: '@demo/plugin-mystery'",
			"      disabled: !!js totallyUnknownSwitch === true",
		]);

		const result = await service().setRowEnabled({ id: "mystery", enabled: false });

		expect(result.ok).toBe(false);
		expect(result.error).toContain("表达式");
	});

	it("creates the profile patch when the profile ships none", async () => {
		profileWith(["- insert:", "    - id: alpha", "      name: '@demo/plugin-alpha'"]);

		const result = await service().setRowEnabled({ id: "alpha", enabled: false });

		expect(result.ok).toBe(true);
		expect(fs.readFileSync(path.join(profileDir, "cordis.patch.yml"), "utf8")).toContain("- id: alpha");
	});

	it("re-scans extensions after a toggle so an enabled row actually mounts", async () => {
		// The toggle is a control, not an annotation: without the re-scan the
		// profile patch would say "on" while the runtime never heard about it.
		profileWith(["- insert:", "    - id: alpha", "      name: '@demo/plugin-alpha'"]);
		let scans = 0;
		const svc = new BundleService({
			cwd: () => profileDir,
			home: () => home,
			invalidate: () => {},
			profileName: () => "desktop",
			refreshExtensions: async () => {
				scans += 1;
			},
		});

		await svc.setRowEnabled({ id: "alpha", enabled: false });

		expect(scans).toBe(1);
	});

	it("reports no entries for a profile that declares nothing", async () => {
		const view = await service().entries();

		expect(view.paths).toEqual([]);
	});
});
