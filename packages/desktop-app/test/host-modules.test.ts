import "./happy-dom-shim";
import { beforeEach, describe, expect, it } from "bun:test";
import { EXTENSION_HOST_MODULES } from "@musepi/collab-proto/extension-host-modules";
import { exposeHostModules } from "../src/lib/host-modules";

type HostWindow = {
	MusePiHostModules?: Record<string, unknown>;
	MusePiPromptDialog?: unknown;
	MusePiManagedBrowserHost?: unknown;
};

function hostWindow(): HostWindow {
	return window as unknown as HostWindow;
}

function hostModule(key: string): Record<string, unknown> | undefined {
	return hostWindow().MusePiHostModules?.[key] as Record<string, unknown> | undefined;
}

describe("host module table", () => {
	beforeEach(() => {
		exposeHostModules();
	});

	it("publishes exactly the contract keys on window.MusePiHostModules", () => {
		const exposed = hostWindow().MusePiHostModules;
		expect(exposed).toBeDefined();
		expect(Object.keys(exposed ?? {}).sort()).toEqual(EXTENSION_HOST_MODULES.map(entry => entry.key).sort());
	});

	it("binds an instance for every contract key", () => {
		for (const { key } of EXTENSION_HOST_MODULES) {
			expect(hostModule(key)).toBeDefined();
		}
	});

	it("exposes the plugin-facing hooks and stores", () => {
		expect(typeof hostModule("prompt-dialog")?.useConfirm).toBe("function");
		expect(typeof hostModule("floating-menu")?.useFloatingMenu).toBe("function");
		expect(typeof hostModule("action-toast")?.pushActionToast).toBe("function");
		expect(typeof hostModule("file-workspace")?.filePreviewBuffers).toBe("object");
	});

	it("keeps the pre-table globals as aliases of the same objects", () => {
		expect(hostWindow().MusePiPromptDialog).toBe(hostModule("prompt-dialog"));
		expect(hostWindow().MusePiManagedBrowserHost).toBe(hostModule("managed-browser-host"));
	});
});
