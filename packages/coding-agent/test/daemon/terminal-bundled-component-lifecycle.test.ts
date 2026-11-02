import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { CordisDynamicPluginRuntime } from "../../src/daemon/cordis-dynamic-plugins";
import { DaemonHostContext } from "../../src/daemon/host-context";
import { TerminalRegistry } from "../../src/daemon/terminal-registry";

const TERMINAL_PACKAGE = path.resolve(import.meta.dir, "../../src/bundled-plugins/terminal");

describe("bundled terminal provider component lifecycle", () => {
	it("mounts real backends and unregisters exactly the disabled component", async () => {
		const host = new DaemonHostContext();
		const runtime = new CordisDynamicPluginRuntime(host);
		const registry = new TerminalRegistry();
		runtime.provideHostService("terminal:backends", registry);
		try {
			await runtime.load(TERMINAL_PACKAGE, process.cwd());
			expect(registry.listBackends().sort()).toEqual(["bun-pty", "node-pty"]);

			await runtime.setComponentEnabled("terminal", "bun-pty", false);
			expect(registry.hasBackend("bun-pty")).toBe(false);
			expect(registry.hasBackend("node-pty")).toBe(true);

			await runtime.setComponentEnabled("terminal", "bun-pty", true);
			expect(registry.hasBackend("bun-pty")).toBe(true);

			await runtime.unloadPlugin("terminal");
			expect(registry.listBackends()).toEqual([]);
		} finally {
			await runtime.dispose();
			await host.dispose();
		}
	}, 30_000);
});
