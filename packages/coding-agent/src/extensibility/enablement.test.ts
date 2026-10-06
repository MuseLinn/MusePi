import { describe, expect, it } from "bun:test";
import { isKnownEnablementCondition, knownEnablementConditions } from "./enablement";

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
