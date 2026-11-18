/**
 * The capability center keeps a local mirror of the daemon's bundled-skill
 * list (the browser bundle must not import the agent package). A drifted
 * mirror silently changes what the UI calls "built-in": a shipped skill looks
 * user-installed (uninstall button appears) or a user skill looks built-in
 * (uninstall blocked). The two lists are one contract, so they are compared
 * from source.
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";

const appRoot = path.resolve(import.meta.dir, "..");
const repoRoot = path.resolve(appRoot, "..", "..");

function namesIn(source: string): string[] {
	const match = /BUNDLED_SKILL_NAMES[^=]*=\s*\[([^\]]*)\]/.exec(source);
	if (!match) throw new Error("BUNDLED_SKILL_NAMES array not found");
	return [...match[1]!.matchAll(/"([^"]+)"/g)].map(entry => entry[1]!);
}

async function read(relative: string): Promise<string> {
	return Bun.file(path.join(repoRoot, relative)).text();
}

describe("bundled skill inventory", () => {
	it("keeps the capability center mirror equal to the daemon list", async () => {
		const daemon = namesIn(await read("packages/coding-agent/src/bundled-skills/index.ts"));
		const gui = namesIn(await read("apps/desktop/src/components/CapabilityCenter.tsx"));
		expect(gui).toEqual(daemon);
	});

	it("does not list a maintainer-only skill as shipped", async () => {
		const daemon = namesIn(await read("packages/coding-agent/src/bundled-skills/index.ts"));
		expect(daemon).not.toContain("musepi-contributing");
	});
});
