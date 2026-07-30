import { expect, test } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";

const preloadPath = path.join(import.meta.dir, "fixtures", "auth-broker-wire-construction-preload.ts");
const probePath = path.join(import.meta.dir, "fixtures", "auth-broker-wire-construction-probe.ts");

test("auth-broker wire schemas construct only on first validation", async () => {
	const tempDir = TempDir.createSync("@auth-broker-wire-");
	try {
		const proc = Bun.spawn([process.execPath, "--preload", preloadPath, probePath, tempDir.path()], {
			cwd: path.join(import.meta.dir, "../../.."),
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);

		expect(exitCode, stderr).toBe(0);
		expect(JSON.parse(stdout)).toEqual({
			counts: {
				afterModuleImport: 0,
				afterLocalDiscovery: 0,
				afterConstruction: 0,
				afterFirstHealth: 1,
				afterSecondHealth: 1,
			},
			firstHealth: { ok: true, version: "wire-lazy-probe" },
			secondHealth: { ok: true, version: "wire-lazy-probe" },
		});
	} finally {
		await tempDir.remove().catch(() => {});
	}
}, 60_000);
