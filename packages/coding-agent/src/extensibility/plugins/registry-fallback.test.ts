import { describe, expect, it } from "bun:test";
import {
	attributeFailure,
	NPMMIRROR_REGISTRY,
	normalizeRegistry,
	OFFICIAL_NPM_REGISTRY,
	registryArgument,
	registryPlan,
} from "./registry-fallback";
import { parseInstallSpec } from "./spec-classifier";

/**
 * A fallback chain has one failure mode worse than not having one: asking a
 * public registry for a package name that only exists on a private one. That
 * both leaks internal names and gets an answer from an index that does not own
 * them. These cases pin the decisions that prevent it, and the decision that
 * makes a second attempt worth anything at all.
 */
describe("registryPlan", () => {
	const official = OFFICIAL_NPM_REGISTRY;
	const mirror = NPMMIRROR_REGISTRY;

	it("asks the configured first registry, then the fallbacks", () => {
		expect(registryPlan(undefined, { registry: official, fallbackRegistries: [mirror], resolved: official })).toEqual(
			[official, mirror],
		);
	});

	it("keeps a private registry first rather than falling through it", () => {
		// The private registry is asked; a public mirror may follow it as a
		// fallback for the packages the private one does not carry. What must never
		// happen is the private one being skipped or replaced — a package that
		// exists only on the internal index would then be asked for by name on a
		// public registry that does not own it.
		expect(
			registryPlan(undefined, {
				registry: "https://npm.internal.example/",
				fallbackRegistries: [official],
				resolved: null,
			}),
		).toEqual(["https://npm.internal.example/", official]);
	});

	it("asks a registry outside the configured set alone", () => {
		// Naming a registry the configuration does not list grants it the first
		// attempt only. Letting it inherit the configured fallbacks would reach a
		// public registry from a caller that never asked for one.
		expect(
			registryPlan("https://npm.other.example/", {
				registry: "https://npm.internal.example/",
				fallbackRegistries: [],
				resolved: null,
			}),
		).toEqual(["https://npm.other.example/"]);
	});

	it("keeps the package manager's own registry out of a chain that holds a public one", () => {
		// `null` means "whatever the package manager is configured with". While
		// that is unknown it cannot join a chain containing a public registry.
		expect(registryPlan(undefined, { registry: null, fallbackRegistries: [official], resolved: null })).toEqual([
			null,
		]);
	});

	it("lets the package manager's own registry join once it resolves to a public one", () => {
		expect(registryPlan(undefined, { registry: null, fallbackRegistries: [mirror], resolved: official })).toEqual([
			null,
			mirror,
		]);
	});

	it("deduplicates registries that normalize to the same URL", () => {
		// A trailing slash and host case are the same server; asking it twice
		// spends an install attempt on nothing.
		expect(
			registryPlan(undefined, {
				registry: "https://registry.npmjs.org",
				fallbackRegistries: ["https://REGISTRY.npmjs.org/"],
				resolved: null,
			}),
		).toEqual([official]);
	});

	it("asks the named registry first when it is one of the configured ones", () => {
		expect(registryPlan(mirror, { registry: official, fallbackRegistries: [mirror], resolved: official })).toEqual([
			mirror,
			official,
		]);
	});
});

describe("normalizeRegistry", () => {
	it("adds the trailing slash two registries are compared by", () => {
		expect(normalizeRegistry("https://registry.npmjs.org")).toBe(OFFICIAL_NPM_REGISTRY);
	});

	it("refuses anything that is not an http(s) URL", () => {
		// A registry the package manager cannot reach would fail later with a
		// message about the install, hiding the configuration mistake.
		expect(() => normalizeRegistry("ftp://registry.example/")).toThrow(/http\(s\) URL/);
		expect(() => normalizeRegistry("not a url")).toThrow(/http\(s\) URL/);
	});
});

describe("registryArgument", () => {
	it("passes a URL through and defers on the package manager's own", () => {
		expect(registryArgument(OFFICIAL_NPM_REGISTRY)).toEqual([`--registry=${OFFICIAL_NPM_REGISTRY}`]);
		expect(registryArgument(null)).toEqual([]);
	});
});

describe("attributeFailure", () => {
	const gitSpec = parseInstallSpec("github:owner/repo");
	const tarballSpec = parseInstallSpec("https://cdn.example.com/pkg-1.0.0.tgz");
	const registrySpec = parseInstallSpec("acme-plugin");

	it("treats a package spec's network failure as the registry's", () => {
		// Every byte of a package comes through the registry.
		expect(attributeFailure("network", "ENOTFOUND registry.npmjs.org", registrySpec)).toBe("registry");
	});

	it("treats a failure naming a git host as that host's, not the registry's", () => {
		// The clone happens before any dependency is fetched; no registry answers
		// for github.com.
		expect(attributeFailure("network", "ssh: Could not resolve hostname github.com", gitSpec)).toBe("spec-host");
	});

	it("reads a tarball CDN failure as the CDN's", () => {
		// The case where the message alone would mislead: a 502 from the tarball's
		// own CDN is the CDN's, while a 502 from an index would be the registry's.
		const log = "ERR_PNPM_FETCH_502 GET https://cdn.example.com/pkg-1.0.0.tgz: Bad Gateway";
		expect(attributeFailure("network", log, tarballSpec)).toBe("spec-host");
	});

	it("does not retry a failure a registry cannot explain", () => {
		// A refusal the package itself made will be refused everywhere.
		expect(attributeFailure("integrity", "EINTEGRITY tarball mismatch", registrySpec)).toBe("other");
		expect(attributeFailure("permission", "EACCES", registrySpec)).toBe("other");
	});

	it("does not read a warning that names a host as a failure", () => {
		// Progress and warning lines name hosts too; retrying on those spends an
		// install attempt to learn nothing.
		expect(attributeFailure("network", "info using github.com as a source", gitSpec)).toBe("registry");
	});
});
