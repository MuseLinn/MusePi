import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
// daemon.cjs lives outside tsconfig include (electron/) and has no types.
// @ts-expect-error — untyped CJS module (electron/, outside tsconfig include)
import { packagedPluginRoots } from "../electron/daemon.cjs";

const electronProcess = process as typeof process & { resourcesPath?: string };
const originalResourcesPath = electronProcess.resourcesPath;

afterEach(() => {
	if (originalResourcesPath === undefined) delete electronProcess.resourcesPath;
	else electronProcess.resourcesPath = originalResourcesPath;
});

test("resolves both staged plugin trees from the installed daemon directory", async () => {
	const resources = await fs.mkdtemp(path.join(os.tmpdir(), "musepi-daemon-plugins-"));
	try {
		electronProcess.resourcesPath = resources;
		const daemonRoot = path.join(resources, "app.asar.unpacked", "vendor", "daemon");
		const expected = [path.join(daemonRoot, "bundled-plugins"), path.join(daemonRoot, "desktop-plugins")];
		await Promise.all(expected.map(root => fs.mkdir(root, { recursive: true })));

		expect(packagedPluginRoots()).toEqual(expected);
	} finally {
		await fs.rm(resources, { recursive: true, force: true });
	}
});
