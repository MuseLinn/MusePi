import "./happy-dom-shim";
import { beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { t as clientCoreT } from "@musepi/client-core";
import { EXTENSION_HOST_MODULES } from "@musepi/collab-proto/extension-host-modules";
import { compileComponentModule } from "../../coding-agent/src/daemon/extension-artifact-compiler";
import { exposeHostModules } from "../src/lib/host-modules";
import { SlotComponentHost } from "../src/lib/slot-host";

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

	it("registers slot-host's own plugin surface", () => {
		expect(typeof hostModule("slot-host")?.SlotComponentHost).toBe("function");
		expect(hostModule("slot-host")?.SlotComponentHost).toBe(SlotComponentHost);
	});

	it("exposes the plugin-facing hooks and stores", () => {
		expect(typeof hostModule("prompt-dialog")?.useConfirm).toBe("function");
		expect(typeof hostModule("floating-menu")?.useFloatingMenu).toBe("function");
		expect(typeof hostModule("action-toast")?.pushActionToast).toBe("function");
		expect(typeof hostModule("file-workspace")?.filePreviewBuffers).toBe("object");
	});

	it("shares the update UX store and tooltip runtime", () => {
		expect(hostWindow().MusePiHostModules).toHaveProperty("update-ux");
		expect(hostWindow().MusePiHostModules).toHaveProperty("tooltips");
		expect(typeof hostModule("update-ux")?.subscribeUpdateUx).toBe("function");
		expect(typeof hostModule("tooltips")?.initTooltips).toBe("function");
	});

	it("keeps the pre-table globals as aliases of the same objects", () => {
		expect(hostWindow().MusePiPromptDialog).toBe(hostModule("prompt-dialog"));
		expect(hostWindow().MusePiManagedBrowserHost).toBe(hostModule("managed-browser-host"));
	});

	it("shares the client-core namespace and its locale state", () => {
		const clientCore = hostModule("client-core");
		const i18n = hostModule("i18n");
		expect(clientCore?.t).toBe(clientCoreT);
		expect(i18n?.t).toBe(clientCoreT);
		expect(typeof i18n?.setLocale).toBe("function");

		const setLocale = i18n?.setLocale as (locale: string) => void;
		const translate = clientCore?.t as (key: "settings.cancel") => string;
		try {
			setLocale("zh-CN");
			expect(translate("settings.cancel")).toBe("取消");
		} finally {
			setLocale("en-US");
		}
		expect(translate("settings.cancel")).toBe("Cancel");
	});

	it("compiles the chat page against slot-host instead of bundling it", async () => {
		const { code } = await compileComponentModule(path.resolve("src/plugins/chat-view/page.tsx"));
		expect(code).toContain('missing "slot-host"');
		expect(code).not.toContain("ConfirmContext");
	}, 60_000);
});
