import { describe, expect, it } from "bun:test";
import {
	enablementHolds,
	isKnownEnablementCondition,
	knownEnablementConditions,
	readSubsystemEnabled,
	subsystemVisible,
} from "./enablement";

/**
 * Two registries of named predicates exist: the one here, which the loader asks
 * whether a plugin may load, and the one the settings panel uses to decide
 * whether a setting is shown. Several predicates ask the same question of the
 * same setting — whether the browser subsystem is on, whether speech input is
 * configured — and each registry answering it separately is how the two drift:
 * a setting gains a new default on one side and the other keeps assuming the
 * old one.
 *
 * The two answer differently when they cannot read the value, and that
 * difference is deliberate. A gate that cannot be decided keeps the plugin out,
 * because the gate exists to keep things out. A panel that cannot be decided
 * keeps the setting visible, because a setting hidden by a failed read cannot
 * be turned back on. So the shared names here are the questions, and each
 * registry supplies its own failure direction.
 */
describe("enablement condition registry", () => {
	it("names conditions a manifest may use", () => {
		// The names a plugin author can write. Anything else loads
		// unconditionally and is warned about, so this list is the whole surface.
		expect([...knownEnablementConditions()].sort()).toEqual([
			"browserEnabled",
			"computerEnabled",
			"desktopShell",
			"lspEnabled",
			"macOS",
			"profileIs",
			"speechEnabled",
			"sttEnabled",
		]);
	});

	it("resolves a condition only when its argument is present where one is needed", () => {
		// `profileIs` compares against a named profile; without one there is
		// nothing to compare, so it must not resolve. The others take none, and an
		// argument they ignore is still their own question.
		expect(isKnownEnablementCondition("profileIs", "desktop")).toBe(true);
		expect(isKnownEnablementCondition("profileIs")).toBe(false);
		expect(isKnownEnablementCondition("lspEnabled")).toBe(true);
		expect(isKnownEnablementCondition("lspEnabled", "irrelevant")).toBe(true);
	});

	it("does not resolve a name no registry knows", () => {
		expect(isKnownEnablementCondition("someConditionFromANewerBuild")).toBe(false);
		expect(isKnownEnablementCondition("")).toBe(false);
	});

	it("reads the same settings the panel's own predicates read", async () => {
		// The real overlap with the settings panel is five questions about five
		// setting keys. If one of those keys is renamed or removed, this registry
		// and the panel's would answer differently about the same subsystem, and
		// a plugin gated on it would be skipped while its settings stayed visible.
		// Reading the keys back through the schema is what makes the overlap
		// checkable without inspecting either registry's source.
		const { SETTINGS_SCHEMA } = await import("../config/settings-schema");
		for (const key of ["stt.enabled", "speech.enabled", "browser.enabled", "computer.enabled", "lsp.enabled"]) {
			expect({ key, present: key in SETTINGS_SCHEMA }).toEqual({ key, present: true });
		}
		// `shell.enabled` is the exception, and it is recorded rather than left to
		// be discovered: the desktop shell is enabled unless something explicitly
		// turned it off, so the key carries a meaning without a schema entry. It
		// is readable and writable through the extension service but has no
		// settings-panel entry, so nothing outside this host can set it. If it is
		// ever given a schema entry, this assertion is where that gets noticed.
		expect("shell.enabled" in SETTINGS_SCHEMA).toBe(false);
	});
});

/**
 * The two consumers of a subsystem's switch disagree about what an unreadable
 * answer means, and that disagreement is the point. Sharing the read is right;
 * sharing the answer would be wrong. These cases pin both directions against the
 * same keys, so a later "simplification" that collapses them has to fail here.
 *
 * Settings are unreadable until the configuration layer is up, and both a gate
 * and a panel have to answer during early boot, so this is a state the code
 * really reaches rather than a defensive branch.
 */
describe("unreadable subsystem switches", () => {
	it("keeps a plugin out when its switch cannot be read", () => {
		// Refusing to answer is not permission to load.
		expect(enablementHolds("lspEnabled")).toBe(false);
		expect(enablementHolds("sttEnabled")).toBe(false);
		expect(enablementHolds("computerEnabled")).toBe(false);
	});

	it("keeps the settings reachable when the same switch cannot be read", () => {
		// The same read, the opposite question. A panel that hid its own settings
		// on a failed read would leave the person with no way to turn the plugin
		// back on.
		expect(subsystemVisible("lsp.enabled")).toBe(true);
		expect(subsystemVisible("stt.enabled")).toBe(true);
	});

	it("treats every switch as unreadable before settings are initialized", () => {
		// The state the gate actually meets on a cold start, and the reason the
		// failure direction is worth specifying at all. Settings cannot be read
		// before `Settings.init`, so both directions below are answers to "I do
		// not know", not answers to "no".
		const keys = ["lsp.enabled", "browser.enabled", "stt.enabled", "speech.enabled", "computer.enabled"] as const;
		for (const key of keys) {
			expect({ key, answer: readSubsystemEnabled(key) }).toEqual({ key, answer: undefined });
		}
	});
});
