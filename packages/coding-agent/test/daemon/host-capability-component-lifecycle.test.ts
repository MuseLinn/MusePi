import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Settings } from "@musepi/pi-coding-agent/config/settings";
import { CordisDynamicPluginRuntime } from "../../src/daemon/cordis-dynamic-plugins";
import { DaemonHostContext } from "../../src/daemon/host-context";
import { isCapabilityActive, resetCapabilityActivations } from "../../src/extensibility/capability-activation";
import { resolveBrowserKind } from "../../src/tools/browser";
import { isFileBackendToolAllowed, isFileIndexBackendEnabled } from "../../src/tools/file-backend";

// Plugin packages are grouped by domain, so each one is named by its path
// under `src/plugins` rather than by a flat directory name.
const PACKAGES = ["fs/file-tools", "web/browser", "io/computer", "capabilities/lsp"] as const;

describe("bundled host capability component lifecycle", () => {
	it("drives file tools, browser resolution and tool availability from fibers", async () => {
		const host = new DaemonHostContext();
		const runtime = new CordisDynamicPluginRuntime(host);
		const session = { settings: Settings.isolated(), cwd: process.cwd() } as Parameters<typeof resolveBrowserKind>[1];
		try {
			for (const name of PACKAGES) {
				await runtime.load(path.resolve(import.meta.dir, "../../src/plugins", name), process.cwd());
			}
			await runtime.setComponentEnabled("file-tools", "write", false);
			expect(isFileBackendToolAllowed("edit")).toBe(false);
			expect(isFileBackendToolAllowed("read")).toBe(true);
			await runtime.setComponentEnabled("file-tools", "write", true);
			expect(isFileBackendToolAllowed("edit")).toBe(true);

			await runtime.setComponentEnabled("file-tools", "index", false);
			expect(isFileIndexBackendEnabled()).toBe(false);

			await runtime.setComponentEnabled("browser", "launch", false);
			expect(() => resolveBrowserKind({ action: "open" }, session)).toThrow("no browser backend available");
			await runtime.setComponentEnabled("browser", "launch", true);
			expect(resolveBrowserKind({ action: "open" }, session).kind).toBe("headless");

			// `computer` and `lsp` are single-entry packages: their capability
			// activates with the plugin itself rather than through a component.
			expect(isCapabilityActive("tool", "computer")).toBe(true);
			expect(isCapabilityActive("tool", "lsp")).toBe(true);
		} finally {
			await runtime.dispose();
			await host.dispose();
			resetCapabilityActivations();
		}
	}, 30_000);
});
