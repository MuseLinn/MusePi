import { describe, expect, it } from "bun:test";
import { Settings } from "../../src/config/settings";
import { findMemoryBackendProvider } from "../../src/memory-backend/providers";
import { resolveMemoryBackend } from "../../src/memory-backend/resolve";

/**
 * Contract: each real memory backend is a provider when its package is mounted,
 * and `off` is never a provider — it is the absence of one.
 *
 * The provider registry is process-wide, and other test files mount these same
 * packages concurrently, so this asserts the package *definitions* rather than
 * a live global: each backend module is what its package registers, and `off`
 * has no package at all.
 */
describe("memory backend package definitions", () => {
	it("every real backend module exports a backend under its own id", async () => {
		const { localBackend } = await import("../../src/memory-backend/local-backend");
		const { hindsightBackend } = await import("../../src/hindsight/backend");
		const { mnemopiBackend } = await import("../../src/mnemopi/backend");
		const { sharpshooterBackend } = await import("../../src/sharpshooter/backend");
		expect(localBackend.id).toBe("local");
		expect(hindsightBackend.id).toBe("hindsight");
		expect(mnemopiBackend.id).toBe("mnemopi");
		expect(sharpshooterBackend.id).toBe("sharpshooter");
	});

	it("off is a core fallback, never a provider id", async () => {
		const { offBackend } = await import("../../src/memory-backend/off-backend");
		expect(offBackend.id).toBe("off");
		// No package claims it, so no provider is registered for it by a mount.
		expect(findMemoryBackendProvider("off")).toBeUndefined();
	});

	it("resolves off through the core branch", async () => {
		const backend = await resolveMemoryBackend(Settings.isolated({ "memory.backend": "off" }));
		expect(backend.id).toBe("off");
	});
});
