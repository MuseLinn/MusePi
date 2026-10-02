import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, getConfigDirName } from "@musepi/pi-utils";
import { resolveExtensionWatchRoots } from "../../src/daemon/extension-watch-roots";
import { isolateAgentDirForTest, restoreAgentDirForTest } from "../helpers/isolate-agent-dir";

/**
 * Contract: the HMR watch-root list covers the directories extension/plugin
 * discovery actually loads from.
 *
 * The regression this defends is silent and easy to miss in local dev: the
 * previous list held only the two extension-source dirs, so hand-written
 * extensions hot-reloaded while every *installed* plugin — the only kind a
 * user can actually install — got no hot reload at all. Nothing errors; the
 * watcher just watches directories nothing reads.
 */
describe("resolveExtensionWatchRoots", () => {
	let isolatedDir: string;
	let tempHome: string;
	let projectRoot: string;
	let projectCwd: string;

	beforeAll(async () => {
		isolatedDir = await isolateAgentDirForTest("ext-watch-roots-");
		// `home` is the only hermetic lever for the plugins dir: XDG overrides
		// apply on Linux only, so on Windows a no-arg getPluginsDir() would
		// resolve to the developer's real ~/.musepi/plugins.
		tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "ext-watch-home-"));
		// A `.git` anchor makes this a project root under the same walk-up rule
		// install/uninstall/list/discovery share.
		projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ext-watch-proj-"));
		await fs.mkdir(path.join(projectRoot, ".git"));
		projectCwd = path.join(projectRoot, "packages", "thing");
		await fs.mkdir(projectCwd, { recursive: true });
	}, 30000);

	afterAll(async () => {
		await restoreAgentDirForTest(isolatedDir);
		await fs.rm(tempHome, { recursive: true, force: true });
		await fs.rm(projectRoot, { recursive: true, force: true });
	}, 30000);

	it("watches the installed-plugin roots, not just the extension-source dirs", async () => {
		const roots = await resolveExtensionWatchRoots(projectCwd, tempHome);

		// The regression: user plugins dir (marketplace install / plugin link).
		expect(roots).toContain(path.join(tempHome, getConfigDirName(), "plugins"));
		// The regression: project plugin dir — anchored above cwd, not at cwd.
		expect(roots).toContain(path.join(projectRoot, getConfigDirName(), "plugins"));
	});

	it("keeps watching both extension-source roots", async () => {
		const roots = await resolveExtensionWatchRoots(projectCwd, tempHome);

		expect(roots).toContain(path.join(getAgentDir(), "extensions"));
		expect(roots).toContain(path.join(projectCwd, getConfigDirName(), "extensions"));
	});

	it("reports each root once when paths coincide", async () => {
		const roots = await resolveExtensionWatchRoots(projectCwd, tempHome);

		expect(new Set(roots).size).toBe(roots.length);
	});
});
