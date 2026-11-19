import { describe, expect, it } from "bun:test";
import { t } from "../src/i18n/index.js";
import { composerPlaceholder } from "../src/lib/composer-placeholder";

describe("composerPlaceholder", () => {
	it("read-only wins over every other state", () => {
		expect(
			composerPlaceholder({ surface: "session", readOnly: true, working: true, designPlaceholder: "design" }),
		).toBe(t("composer.readOnlySessionWatching"));
	});

	it("waits for a session before teaching anything", () => {
		expect(composerPlaceholder({ surface: "session", waiting: true })).toBe(t("composer.waitingSession"));
	});

	it("lets the creation rail own its brief", () => {
		expect(composerPlaceholder({ surface: "welcome", designPlaceholder: "draw a poster" })).toBe("draw a poster");
	});

	it("announces a running turn before attachment coaching", () => {
		expect(composerPlaceholder({ surface: "session", working: true, attachmentCount: 2 })).toBe(
			t("composer.placeholderWorking"),
		);
	});

	it("asks for a note when attachments are staged", () => {
		expect(composerPlaceholder({ surface: "session", attachmentCount: 1 })).toBe(
			t("composer.placeholderAttachments"),
		);
	});

	it("welcome teaches the task, not the syntax only", () => {
		expect(composerPlaceholder({ surface: "welcome" })).toBe(t("composer.placeholderWelcome"));
		expect(composerPlaceholder({ surface: "welcome", compact: true })).toBe(t("composer.askAnythingShort"));
	});

	it("an empty session teaches @ and /; a conversation stays quiet", () => {
		expect(composerPlaceholder({ surface: "session" })).toBe(t("composer.placeholderSessionCoach"));
		expect(composerPlaceholder({ surface: "session", hasConversation: true })).toBe(t("composer.placeholderSession"));
		expect(composerPlaceholder({ surface: "session", compact: true })).toBe(t("composer.askAnythingShort"));
	});
});
