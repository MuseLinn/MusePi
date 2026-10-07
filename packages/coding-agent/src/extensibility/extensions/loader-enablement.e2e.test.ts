/**
 * End-to-end proof that a manifest `when` condition keeps a plugin out of the
 * loaded set. The loader path is exercised with real filesystem fixtures —
 * the same gate, the same manifest reader, no stubs.
 */
import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { loadExtensions } from "./loader";

async function plugin(home: string, name: string, when: unknown): Promise<string> {
	const dir = path.join(home, "ext-plugins", name);
	await mkdir(dir, { recursive: true });
	await writeFile(
		path.join(dir, "package.json"),
		JSON.stringify({
			name,
			version: "1.0.0",
			musepi: { extensions: ["index.ts"], ...(when === undefined ? {} : { when }) },
		}),
	);
	await writeFile(path.join(dir, "index.ts"), "export default (pi: unknown) => {};");
	return path.join(dir, "index.ts");
}

describe("loadExtensions honours manifest conditions", () => {
	it("skips a plugin whose condition cannot hold", async () => {
		const home = await mkdtemp(path.join(tmpdir(), "enablement-e2e-"));
		try {
			const gatedPath = await plugin(home, "gated-out", { profileIs: "profile-this-process-is-not" });
			const openPath = await plugin(home, "always-in", undefined);

			const { extensions, errors } = await loadExtensions([gatedPath, openPath], home);

			expect(errors).toEqual([]);
			// The gated plugin is absent, the unconditional one is present.
			expect(extensions.map(e => e.path)).not.toContain(gatedPath);
			expect(extensions.some(e => e.path === openPath || e.path.includes("always-in"))).toBe(true);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});
});
