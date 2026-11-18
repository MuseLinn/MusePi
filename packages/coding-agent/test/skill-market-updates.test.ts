/**
 * Skill update checks compare the facts an install recorded, never a bare
 * name: SkillHub publishes a version, skills.sh/git installs move by commit.
 * A source that cannot answer is "unknown", not "current".
 */
import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { checkSkillUpdates, compareSkillUpdate, matchSkillAlternatives } from "../src/skills/market-updates";
import { readSkillSource, type SkillSourceRecord, writeSkillSource } from "../src/skills/skill-source";

describe("skill provenance sidecar", () => {
	it("round-trips a record and rejects unknown shapes", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "musepi-skill-source-"));
		try {
			expect(await readSkillSource(dir)).toBeNull();
			await writeSkillSource(dir, {
				schemaVersion: 1,
				source: "skillhub",
				slug: "demo",
				version: "1.2.0",
				installedAt: "2026-11-18T00:00:00.000Z",
			});
			expect(await readSkillSource(dir)).toEqual({
				schemaVersion: 1,
				source: "skillhub",
				slug: "demo",
				version: "1.2.0",
				installedAt: "2026-11-18T00:00:00.000Z",
			});
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("ignores a sidecar written by something else", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "musepi-skill-source-"));
		try {
			await Bun.write(path.join(dir, ".musepi-skill.json"), JSON.stringify({ source: "socket" }));
			expect(await readSkillSource(dir)).toBeNull();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("compareSkillUpdate", () => {
	it("uses the SkillHub version when both sides publish one", () => {
		const record: SkillSourceRecord = { schemaVersion: 1, source: "skillhub", version: "1.0.0", installedAt: "" };
		expect(compareSkillUpdate(record, { version: "1.1.0" })).toBe(true);
		expect(compareSkillUpdate(record, { version: "1.0.0" })).toBe(false);
	});

	it("falls back to commits for skills.sh / git installs", () => {
		const record: SkillSourceRecord = { schemaVersion: 1, source: "skills.sh", commit: "aaaaaaa", installedAt: "" };
		expect(compareSkillUpdate(record, { commit: "bbbbbbb" })).toBe(true);
		expect(compareSkillUpdate(record, { commit: "aaaaaaa" })).toBe(false);
	});

	it("is unknown, not current, when the source cannot be compared", () => {
		const record: SkillSourceRecord = { schemaVersion: 1, source: "git", installedAt: "" };
		expect(compareSkillUpdate(record, null)).toBeNull();
		expect(compareSkillUpdate(record, { version: "1.0.0" })).toBeNull();
	});
});

describe("matchSkillAlternatives", () => {
	it("lists the same skill from both catalogs and marks the installed source", () => {
		const record: SkillSourceRecord = {
			schemaVersion: 1,
			source: "skillhub",
			slug: "dev-expert",
			installedAt: "",
		};
		const candidates = matchSkillAlternatives(
			[
				{
					id: "skillhub:dev-expert",
					source: "skillhub",
					slug: "dev-expert",
					name: "Dev Expert",
					description: "",
					version: "2.0.0",
				},
				{
					id: "skills.sh:dev-expert",
					source: "skills.sh",
					slug: "dev-expert",
					name: "Dev Expert",
					description: "",
					repo: "acme/skills",
				},
				{ id: "skillhub:other", source: "skillhub", slug: "other", name: "Other", description: "" },
			],
			record,
			"Dev Expert",
		);
		expect(candidates.map(candidate => [candidate.source, candidate.slug, candidate.current])).toEqual([
			["skillhub", "dev-expert", true],
			["skills.sh", "dev-expert", false],
		]);
	});

	it("matches by slug when the catalog display name differs", () => {
		const record: SkillSourceRecord = {
			schemaVersion: 1,
			source: "skills.sh",
			slug: "dev-expert",
			repo: "acme/skills",
			installedAt: "",
		};
		const candidates = matchSkillAlternatives(
			[
				{
					id: "skillhub:dev-expert",
					source: "skillhub",
					slug: "dev-expert",
					name: "编程专家",
					description: "",
					version: "1.1.0",
				},
			],
			record,
			"dev-expert",
		);
		expect(candidates).toHaveLength(1);
		expect(candidates[0]?.latestVersion).toBe("1.1.0");
	});
});

describe("checkSkillUpdates", () => {
	it("skips skills without provenance and reports one status per recorded install", async () => {
		const { updates, failures } = await checkSkillUpdates(
			[
				{ name: "authored" },
				{
					name: "demo",
					market: {
						schemaVersion: 1,
						source: "skillhub",
						slug: "demo",
						version: "1.0.0",
						installedAt: "",
					} satisfies SkillSourceRecord,
				},
			],
			async () => ({ version: "2.0.0" }),
			async () => [],
		);
		expect(updates.map(update => update.name)).toEqual(["demo"]);
		expect(updates[0]).toMatchObject({
			source: "skillhub",
			installedVersion: "1.0.0",
			latestVersion: "2.0.0",
			updateAvailable: true,
		});
		expect(failures).toEqual([]);
	});

	it("keeps an unreachable source as an unknown status with a failure line", async () => {
		const { updates, failures } = await checkSkillUpdates(
			[
				{
					name: "demo",
					market: {
						schemaVersion: 1,
						source: "skills.sh",
						repo: "acme/repo",
						slug: "demo",
						commit: "aaaaaaa",
						installedAt: "",
					} satisfies SkillSourceRecord,
				},
			],
			async () => null,
			async () => [],
		);
		expect(updates[0]?.updateAvailable).toBeNull();
		expect(failures).toHaveLength(1);
		expect(failures[0]).toContain("demo");
	});
});
