/**
 * A failed mount must run the cleanups of whatever it already registered.
 *
 * The failure path used to drop the effect ledger without running it, so a
 * plugin that registered a memory backend provider and then threw left the
 * provider in the table: the rollback remount of the previous module then
 * failed with "already registered" and the host stayed without its
 * process-wide registrations.
 */
import { afterEach, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ExtensionRuntime } from "../src/extensibility/extensions/loader";
import { mountPlugin } from "../src/extensibility/plugins/runtime/mount";
import { findMemoryBackendProvider } from "../src/memory-backend/providers";
import { EventBus } from "../src/utils/event-bus";

const dirs: string[] = [];

afterEach(async () => {
	await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

it("runs registered cleanups when apply throws after registering", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "mount-cleanup-"));
	dirs.push(root);
	const entryPath = path.join(root, "leaky.ts");
	await Bun.write(
		entryPath,
		`export default {
	name: "leaky",
	apply(pi) {
		pi.registerMemoryBackendProvider({
			id: "mount-cleanup-regression",
			create: () => {
				throw new Error("never used");
			},
		});
		throw new Error("boom after registering");
	},
};
`,
	);

	const result = await mountPlugin({
		entryPath,
		cwd: root,
		eventBus: new EventBus(),
		runtime: new ExtensionRuntime() as never,
		readConfig: async () => ({ fields: [], values: {} }),
	});

	expect(result.ok).toBe(false);
	expect(findMemoryBackendProvider("mount-cleanup-regression")).toBeUndefined();
});
