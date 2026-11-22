import { describe, expect, test } from "bun:test";
import {
	COMPOSER_BAR_SLOT,
	COMPOSER_DOCK_SLOT,
	HERO_FRAME_SLOT,
	SESSION_INFO_SLOT,
} from "@musepi/client-ui-conversation/client";
import { SETTINGS_EXTENSION_SLOT } from "@musepi/client-ui-settings/client";
import { CONVERSATION_SLOT, PANEL_SHELL_SLOT } from "@musepi/client-ui-shell/client";
import { CAPABILITY_PANEL_SLOT, SIDEBAR_PANEL_SLOT_PREFIX } from "@musepi/client-ui-sidebar/client";
import { defineSlot } from "@musepi/client-ui-slots";

describe("UI seat contracts", () => {
	test("rejects a seat the declaration authority does not know", () => {
		expect(() => defineSlot("not.a.seat")).toThrow(/Unknown extension slot/);
	});

	test("capability packages name the declared seats", () => {
		expect(COMPOSER_BAR_SLOT).toBe("conversation.composer.bar");
		expect(COMPOSER_DOCK_SLOT).toBe("conversation.composer.dock");
		expect(HERO_FRAME_SLOT).toBe("conversation.hero.frame");
		expect(SESSION_INFO_SLOT).toBe("chat.session-info.plugins");
		expect(CONVERSATION_SLOT).toBe("main.conversation");
		expect(PANEL_SHELL_SLOT).toBe("panel.shell");
		expect(SETTINGS_EXTENSION_SLOT).toBe("settings.extensions");
		expect(SIDEBAR_PANEL_SLOT_PREFIX).toBe("sidebar.panel.");
		expect(CAPABILITY_PANEL_SLOT).toBe("sidebar.panel.capability");
	});
});
