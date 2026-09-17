import { describe, expect, it } from "bun:test";
import { resolveDaemonSpawnOptions } from "../../src/launch/spawn-options";

describe("resolveDaemonSpawnOptions", () => {
	it("hides Windows daemons when the host has no console", () => {
		expect(
			resolveDaemonSpawnOptions({
				platform: "win32",
				hostHasInheritableConsole: false,
			}),
		).toEqual({ detached: false, windowsHide: true });
	});

	it("inherits the Windows host console instead of detaching", () => {
		expect(
			resolveDaemonSpawnOptions({
				platform: "win32",
				hostHasInheritableConsole: true,
			}),
		).toEqual({ detached: false, windowsHide: false });
	});

	it("keeps POSIX daemons in their own session", () => {
		expect(
			resolveDaemonSpawnOptions({
				platform: "linux",
				hostHasInheritableConsole: false,
			}),
		).toEqual({ detached: true });
	});

	it("detaches a survive-parent daemon from its Windows spawner", () => {
		// Bun kills non-detached children when the parent exits on Windows, so a
		// broker that must outlive its spawner cannot share the spawner's console.
		expect(
			resolveDaemonSpawnOptions({
				platform: "win32",
				hostHasInheritableConsole: true,
				surviveParent: true,
			}),
		).toEqual({ detached: true, windowsHide: true });
	});

	it("treats survive-parent as a no-op on POSIX", () => {
		expect(
			resolveDaemonSpawnOptions({
				platform: "linux",
				hostHasInheritableConsole: true,
				surviveParent: true,
			}),
		).toEqual({ detached: true });
	});
});
