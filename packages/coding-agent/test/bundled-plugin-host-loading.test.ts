/**
 * Host-scope packages mount once per process, with no session: that is what
 * makes a provider visible to session-less RPC (`memory.status`) and to the
 * first session alike.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { ensureHostHalfPluginsLoaded, resetHostHalfPluginsLoaded } from "../src/bundled-plugins/loader";
import { findMemoryBackendProvider } from "../src/memory-backend/providers";

afterEach(() => {
	resetHostHalfPluginsLoaded();
});

describe("host-scope bundled plugins", () => {
	it("mounts without a session and registers the backend provider", async () => {
		resetHostHalfPluginsLoaded();
		expect(findMemoryBackendProvider("sharpshooter")).toBeUndefined();

		expect(await ensureHostHalfPluginsLoaded(process.cwd())).toBe(true);
		expect(findMemoryBackendProvider("sharpshooter")).toMatchObject({ id: "sharpshooter" });

		// One mount per process: a second pass is a no-op.
		expect(await ensureHostHalfPluginsLoaded(process.cwd())).toBe(false);
	});

	it("removes the registration when the host loader resets", async () => {
		resetHostHalfPluginsLoaded();
		await ensureHostHalfPluginsLoaded(process.cwd());
		expect(findMemoryBackendProvider("sharpshooter")).toBeDefined();

		resetHostHalfPluginsLoaded();
		expect(findMemoryBackendProvider("sharpshooter")).toBeUndefined();
	});
});
