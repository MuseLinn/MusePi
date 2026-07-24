import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
	type ChangelogEntry,
	getStartupChangelogEntries,
	normalizeChangelogLinks,
	parseChangelog,
} from "../src/utils/changelog.ts";

const entry: ChangelogEntry = {
	major: 0,
	minor: 1,
	patch: 0,
	content: "",
};

describe("normalizeChangelogLinks", () => {
	test("rewrites package-relative changelog links to tag-pinned GitHub source links", () => {
		const markdown = [
			"[Project Trust](README.md#project-trust)",
			"[Extensions](docs/extensions.md#project_trust)",
			"[Examples](examples/extensions/)",
			"[Root README](../../README.md#supply-chain-hardening)",
		].join("\n");

		expect(normalizeChangelogLinks(markdown, entry)).toBe(
			[
				"[Project Trust](https://github.com/MuseLinn/MusePi/blob/v0.1.0/packages/coding-agent/README.md#project-trust)",
				"[Extensions](https://github.com/MuseLinn/MusePi/blob/v0.1.0/packages/coding-agent/docs/extensions.md#project_trust)",
				"[Examples](https://github.com/MuseLinn/MusePi/tree/v0.1.0/packages/coding-agent/examples/extensions/)",
				"[Root README](https://github.com/MuseLinn/MusePi/blob/v0.1.0/README.md#supply-chain-hardening)",
			].join("\n"),
		);
	});

	test("pins floating MusePi repo links to the release tag without changing external links", () => {
		const markdown = [
			"[Releases](https://github.com/MuseLinn/MusePi/releases)",
			"[Agent README](https://github.com/MuseLinn/MusePi/blob/main/packages/agent/README.md)",
			"[Upstream](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/CHANGELOG.md)",
			"[External](https://example.com/docs)",
			"[Local anchor](#settings)",
		].join("\n");

		expect(normalizeChangelogLinks(markdown, "0.1.0")).toBe(
			[
				"[Releases](https://github.com/MuseLinn/MusePi/releases)",
				"[Agent README](https://github.com/MuseLinn/MusePi/blob/v0.1.0/packages/agent/README.md)",
				"[Upstream](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/CHANGELOG.md)",
				"[External](https://example.com/docs)",
				"[Local anchor](#settings)",
			].join("\n"),
		);
	});
});

describe("getStartupChangelogEntries", () => {
	const entries: ChangelogEntry[] = [
		{ major: 0, minor: 2, patch: 0, content: "## [0.2.0]" },
		{ major: 0, minor: 1, patch: 0, content: "## [0.1.0]" },
	];

	test("returns entries newer than the last seen version", () => {
		expect(getStartupChangelogEntries(entries, "0.1.0", "0.2.0")).toEqual([entries[0]]);
	});

	test("returns undefined for a fresh install (no last seen version)", () => {
		expect(getStartupChangelogEntries(entries, undefined, "0.1.0")).toBeUndefined();
	});

	test("returns undefined when already up to date", () => {
		expect(getStartupChangelogEntries(entries, "0.2.0", "0.2.0")).toBeUndefined();
	});

	test("shows all entries when last seen version comes from a newer foreign distribution", () => {
		// e.g. settings migrated from upstream pi 0.81.x into MusePi 0.1.x
		expect(getStartupChangelogEntries(entries, "0.81.0", "0.2.0")).toEqual(entries);
	});

	test("returns undefined for a foreign last seen version when the changelog is empty", () => {
		expect(getStartupChangelogEntries([], "0.81.0", "0.1.0")).toBeUndefined();
	});
});

describe("parseChangelog", () => {
	test("parses the MusePi package changelog and extracts the current version entry", () => {
		const entries = parseChangelog(fileURLToPath(new URL("../CHANGELOG.md", import.meta.url)));
		expect(entries.length).toBeGreaterThan(0);
		expect(entries[0]).toMatchObject({ major: 0, minor: 1, patch: 0 });
		expect(entries[0].content).toContain("## [0.1.0]");
	});
});
