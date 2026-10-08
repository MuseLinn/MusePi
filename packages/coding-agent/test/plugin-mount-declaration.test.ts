/**
 * Exclusive-mount contract.
 *
 * The failure it prevents is a boot-time collision: two mounts of one package
 * both register a route prefix, a window class, or a fixed port, and the second
 * either throws or silently shadows the first. It is reached in practice by an
 * aggregate bundle that re-declares a plugin another bundle already mounts.
 *
 * Upstream guards this with a `!!js` expression reading the loader's own row
 * table. This host does not evaluate those, so the same property is declared
 * instead — which is also the only version a sandbox could carry, since the
 * upstream form reaches into live runtime state rather than computing from data.
 */
import { describe, expect, it } from "bun:test";
import type { PluginPackageJson } from "../src/extensibility/plugins/manifest-block";
import { decideMount, readMountDeclaration } from "../src/extensibility/plugins/mount-declaration";

function pkgWithMount(mount: unknown): PluginPackageJson {
	return { name: "acme", musepi: { extensions: ["index.ts"], ...(mount === undefined ? {} : { mount }) } };
}

describe("readMountDeclaration", () => {
	it("treats a package that declares nothing as mountable more than once", () => {
		// The permissive default: refusing a second mount would break aggregate
		// bundles for packages with no global footprint at all.
		expect(readMountDeclaration(pkgWithMount(undefined))).toEqual({ exclusive: false });
		expect(readMountDeclaration({ name: "plain" })).toEqual({ exclusive: false });
		expect(readMountDeclaration(null)).toEqual({ exclusive: false });
	});

	it("reads an exclusive mount and the name it owns", () => {
		expect(readMountDeclaration(pkgWithMount({ exclusive: true, owns: "/sidebar/api" }))).toEqual({
			exclusive: true,
			owns: "/sidebar/api",
		});
	});

	it("reads the declaration from a legacy omp or pi block too", () => {
		// Precedence is the manifest block's business; this only confirms the
		// declaration is read from whichever block won.
		expect(readMountDeclaration({ musepi: { mount: { exclusive: true } } }).exclusive).toBe(true);
		expect(readMountDeclaration({ omp: { mount: { exclusive: true } } }).exclusive).toBe(true);
		expect(readMountDeclaration({ pi: { mount: { exclusive: true } } }).exclusive).toBe(true);
	});

	it("does not let a malformed declaration turn into an exclusive mount", () => {
		// A typo in a field nothing depends on must not silently disable a
		// plugin, so only a literal boolean true counts.
		expect(readMountDeclaration(pkgWithMount({ exclusive: "yes" }))).toEqual({ exclusive: false });
		expect(readMountDeclaration(pkgWithMount("exclusive"))).toEqual({ exclusive: false });
		expect(readMountDeclaration(pkgWithMount([]))).toEqual({ exclusive: false });
	});
});

describe("decideMount", () => {
	it("declines a second mount of an exclusive package and names the holder", () => {
		// The refusal has to be actionable: a person reading "already mounted"
		// cannot tell which of the two to remove.
		const mounted = new Map([["better-sidebar", "dsh-better-sidebar"]]);
		const decision = decideMount(
			"web-ui-better-sidebar",
			"dsh-better-sidebar",
			{ exclusive: true, owns: "/sidebar/api" },
			mounted,
		);
		expect(decision).toEqual({ refused: true, heldBy: "better-sidebar", owns: "/sidebar/api" });
	});

	it("allows the first mount", () => {
		expect(
			decideMount("better-sidebar", "dsh-better-sidebar", { exclusive: true, owns: "/sidebar/api" }, new Map()),
		).toEqual({ refused: false });
	});

	it("allows a second mount of a package that did not ask to be exclusive", () => {
		const mounted = new Map([["something-else", "acme-plugin"]]);
		expect(decideMount("acme-plugin-2", "acme-plugin", { exclusive: false }, mounted)).toEqual({ refused: false });
	});

	it("does not treat one entry re-entering as a collision with itself", () => {
		// A reload of the same id is not a second mount, and treating it as one
		// would make every HMR reload refuse itself.
		const mounted = new Map([["better-sidebar", "dsh-better-sidebar"]]);
		expect(
			decideMount("better-sidebar", "dsh-better-sidebar", { exclusive: true, owns: "/sidebar/api" }, mounted),
		).toEqual({ refused: false });
	});

	it("declines even when the two entries hold different packages, if either is exclusive", () => {
		// An exclusive mount claims the name it owns, so anything already holding
		// that name is the collision regardless of what it calls itself. This is
		// the aggregate-bundle case: a different package mounting the same
		// globally-owned surface, and the person has to be told which one.
		const mounted = new Map([["aggregate-slot", "aggregate-bundle"]]);
		expect(decideMount("standalone", "dsh-better-sidebar", { exclusive: true, owns: "sidebar" }, mounted)).toEqual({
			refused: true,
			heldBy: "aggregate-slot",
			heldByName: "aggregate-bundle",
			owns: "sidebar",
		});
	});
});
