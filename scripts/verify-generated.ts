#!/usr/bin/env bun

/**
 * Gate: committed generated artifacts must match their generators.
 *
 * Why a gate: the generator and the artifact are two copies of one fact. A
 * resolver or renderer change that skips `gen:*` leaves the stale artifact
 * looking authoritative — it ships, and nothing in `check:tools` disagrees.
 *
 * Only deterministic, offline generators belong here. `gen:models` fetches
 * provider catalogs and reads local auth, so its output cannot be reproduced on
 * a machine without those; it stays a local step.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { buildToolViews } from "../packages/client-core/scripts/build-tool-views";
import { buildPluginConfigArtifacts } from "../packages/coding-agent/scripts/gen-plugin-config";
import { buildCapabilitySeams } from "./gen-capability-seams";
import { buildSlotCatalog } from "./gen-slot-catalog";

const ROOT = join(import.meta.dir, "..");

/** One generated file and the function that reproduces it. */
interface GeneratedArtifact {
	/** Repository-relative path of the committed artifact. */
	path: string;
	/** Human-readable generator command for the failure message. */
	command: string;
	/** Produce the artifact's expected bytes. */
	build: () => Promise<string>;
}

const ARTIFACTS: GeneratedArtifact[] = [
	{
		path: "packages/coding-agent/src/export/html/tool-views.generated.js",
		command: "bun run gen:tool-views",
		build: buildToolViews,
	},
	{
		path: "packages/collab-proto/src/slot-catalog.generated.ts",
		command: "bun run gen:slot-catalog",
		build: buildSlotCatalog,
	},
	{
		path: "docs/capability-seams.md",
		command: "bun run gen:capability-seams",
		build: buildCapabilitySeams,
	},
];

/**
 * Describe the first divergence between the committed and expected text.
 *
 * Returns `null` when they are identical. The line is the first one whose
 * content differs, which is usually the edit that should have been regenerated.
 */
export function describeDrift(expected: string, actual: string): string | null {
	if (expected === actual) return null;
	const expectedLines = expected.split("\n");
	const actualLines = actual.split("\n");
	const limit = Math.max(expectedLines.length, actualLines.length);
	for (let i = 0; i < limit; i++) {
		if (expectedLines[i] !== actualLines[i]) {
			return `line ${i + 1}\n  committed: ${(actualLines[i] ?? "<missing>").slice(0, 160)}\n  expected:  ${(expectedLines[i] ?? "<missing>").slice(0, 160)}`;
		}
	}
	return `expected ${expected.length} bytes, committed ${actual.length} bytes`;
}

async function main(): Promise<number> {
	const stale: string[] = [];
	let verified = 0;
	for (const artifact of ARTIFACTS) {
		verified += 1;
		const absolute = join(ROOT, artifact.path);
		if (!existsSync(absolute)) {
			stale.push(`${artifact.path}: missing — run \`${artifact.command}\``);
			continue;
		}
		const actual = readFileSync(absolute, "utf8");
		const expected = await artifact.build();
		const drift = describeDrift(expected, actual);
		if (drift) stale.push(`${artifact.path}: stale — run \`${artifact.command}\`\n${drift}`);
	}
	// Plugin config sidecars are one artifact per package, generated from the
	// plugin's `Config` schema; a stale one means the schema changed without a
	// regeneration.
	for (const artifact of await buildPluginConfigArtifacts()) {
		verified += 1;
		const path = relative(ROOT, artifact.path).split(sep).join("/");
		if (!existsSync(artifact.path)) {
			stale.push(`${path}: missing — run \`bun --cwd=packages/coding-agent run gen:plugin-config\``);
			continue;
		}
		const drift = describeDrift(artifact.content, readFileSync(artifact.path, "utf8"));
		if (drift) stale.push(`${path}: stale — run \`bun --cwd=packages/coding-agent run gen:plugin-config\`\n${drift}`);
	}
	if (stale.length === 0) {
		console.log(`generated artifacts ok (${verified} verified)`);
		return 0;
	}
	console.error("generated artifacts are stale:");
	for (const line of stale) console.error(`\n${line}`);
	return 1;
}

if (import.meta.main) process.exit(await main());
