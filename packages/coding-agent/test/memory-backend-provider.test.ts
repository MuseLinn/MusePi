import { afterEach, describe, expect, it } from "bun:test";
import { Settings } from "../src/config/settings";
import { getMemoryRoot } from "../src/memories";
import { registerMemoryBackendProvider } from "../src/memory-backend/providers";
import { resolveMemoryBackend } from "../src/memory-backend/resolve";
import type { MemoryBackend } from "../src/memory-backend/types";

const disposers: Array<() => void> = [];

afterEach(() => {
	for (const dispose of disposers.splice(0)) dispose();
});

function fakeBackend(id: "local" | "mnemopi"): MemoryBackend {
	return {
		id,
		start() {},
		async buildDeveloperInstructions() {
			return `provider:${id}`;
		},
		async clear() {},
		async enqueue() {},
	} as MemoryBackend;
}

describe("memory backend providers", () => {
	it("resolves a registered provider and restores the built-in backend on dispose", async () => {
		const settings = Settings.isolated({ "memory.backend": "local" });
		const dispose = registerMemoryBackendProvider({ id: "local", create: () => fakeBackend("local") });
		disposers.push(dispose);

		expect(await resolveMemoryBackend(settings)).toMatchObject({
			id: "local",
			buildDeveloperInstructions: expect.any(Function),
		});
		expect(await (await resolveMemoryBackend(settings)).buildDeveloperInstructions("", "", settings, undefined)).toBe(
			"provider:local",
		);

		dispose();
		const builtIn = await resolveMemoryBackend(settings);
		expect(await builtIn.buildDeveloperInstructions("/tmp", "/tmp", settings, undefined)).not.toBe("provider:local");
	});

	it("lets the provider decide whether a browsable workspace exists", async () => {
		const settings = Settings.isolated({ "memory.backend": "local" });
		const builtIn = await resolveMemoryBackend(settings);
		expect(builtIn.workspaceDir?.("/tmp/agent", "/tmp/project")).toBe(getMemoryRoot("/tmp/agent", "/tmp/project"));

		const dispose = registerMemoryBackendProvider({ id: "local", create: () => fakeBackend("local") });
		disposers.push(dispose);
		const replaced = await resolveMemoryBackend(settings);
		expect(replaced.workspaceDir).toBeUndefined();
	});

	it("refuses a second provider for the same backend id", () => {
		const dispose = registerMemoryBackendProvider({ id: "mnemopi", create: () => fakeBackend("mnemopi") });
		disposers.push(dispose);
		expect(() => registerMemoryBackendProvider({ id: "mnemopi", create: () => fakeBackend("mnemopi") })).toThrow(
			/already registered/,
		);
	});
});
