import { test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { zipSync } from "fflate";
import { installSkillFromSkillHubZip } from "../src/skills/marketplace-install";

/** Synthetic SkillHub-style archive: SKILL.md at the root, one extra file. */
function makeZip(files: Record<string, string>): Uint8Array {
	return zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, new TextEncoder().encode(v)])));
}

const SKILL_MD = `---
name: zip-skill
description: installed from a zip archive
---
body
`;

test("zip install extracts the root SKILL.md skill into destRoot", async () => {
	const dest = await mkdtemp(path.join(tmpdir(), "musepi-skillhub-test-"));
	try {
		const zip = makeZip({ "SKILL.md": SKILL_MD, "README.md": "hi" });
		const res = await installSkillFromSkillHubZip(zip, dest);
		assert.equal(res.name, "zip-skill");
		assert.ok(existsSync(path.join(res.dir, "SKILL.md")));
		assert.equal(await readFile(path.join(res.dir, "README.md"), "utf8"), "hi");
		// Second install without overwrite refuses.
		await assert.rejects(installSkillFromSkillHubZip(zip, dest), /already exists/);
		// Overwrite replaces.
		const again = await installSkillFromSkillHubZip(zip, dest, { overwrite: true });
		assert.equal(again.name, "zip-skill");
	} finally {
		await rm(dest, { recursive: true, force: true });
	}
});

test("zip install resolves a single nested skill folder", async () => {
	const dest = await mkdtemp(path.join(tmpdir(), "musepi-skillhub-test-"));
	try {
		const zip = makeZip({ "pkg/SKILL.md": SKILL_MD, "pkg/extra.txt": "x" });
		const res = await installSkillFromSkillHubZip(zip, dest);
		assert.ok(existsSync(path.join(res.dir, "extra.txt")));
	} finally {
		await rm(dest, { recursive: true, force: true });
	}
});

test("zip install rejects archives without any SKILL.md", async () => {
	const dest = await mkdtemp(path.join(tmpdir(), "musepi-skillhub-test-"));
	try {
		const zip = makeZip({ "README.md": "no skill here" });
		await assert.rejects(installSkillFromSkillHubZip(zip, dest), /no SKILL\.md/);
	} finally {
		await rm(dest, { recursive: true, force: true });
	}
});

test("zip install neutralizes zip-slip entries", async () => {
	const dest = await mkdtemp(path.join(tmpdir(), "musepi-skillhub-test-"));
	const outside = await mkdtemp(path.join(tmpdir(), "musepi-skillhub-out-"));
	try {
		const escapeTarget = path.join(outside, "evil.txt");
		const zip = makeZip({ "SKILL.md": SKILL_MD, "../evil.txt": "owned" });
		await installSkillFromSkillHubZip(zip, dest, { overwrite: true });
		assert.ok(!existsSync(escapeTarget), "zip-slip entry must not be written outside the scratch dir");
	} finally {
		await rm(dest, { recursive: true, force: true });
		await rm(outside, { recursive: true, force: true });
	}
});

test("zip install surfaces an explicit error on garbage bytes", async () => {
	const dest = await mkdtemp(path.join(tmpdir(), "musepi-skillhub-test-"));
	try {
		await assert.rejects(installSkillFromSkillHubZip(new Uint8Array([1, 2, 3]), dest), /not a valid zip/);
	} finally {
		await rm(dest, { recursive: true, force: true });
	}
});
