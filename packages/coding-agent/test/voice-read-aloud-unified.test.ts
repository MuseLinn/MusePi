/**
 * Contract: one read-aloud config group drives both shells.
 *
 * The desktop (tts.synthesize, sentence-streamed) and the terminal
 * (vocalizer, delta-streamed) used to own independent keys — tts.* and
 * speech.* — so the Settings → Voice page showed two switches, two voice
 * pickers and two scopes with no indication which one applied. Both shells
 * now read tts.*; speech.* survives only as hidden legacy aliases that
 * Settings.get() falls back to, so an existing config.yml keeps working.
 */
import { describe, expect, it } from "bun:test";
import { Settings } from "../src/config/settings";
import { SETTINGS_SCHEMA } from "../src/config/settings-schema";

interface LooseUi {
	tab?: string;
	hidden?: boolean;
	tuiOnly?: boolean;
}
const uiOf = (key: string): LooseUi => (SETTINGS_SCHEMA as Record<string, { ui?: LooseUi }>)[key]?.ui ?? {};

const UNIFIED = ["tts.autoRead", "tts.readMode", "tts.enhanced", "tts.localVoice"] as const;
const LEGACY = ["speech.enabled", "speech.mode", "speech.enhanced", "speech.voice"] as const;

describe("unified read-aloud settings", () => {
	it("exposes exactly one visible control per read-aloud concern", () => {
		for (const key of UNIFIED) {
			expect(uiOf(key).tab, key).toBe("voice");
			expect(uiOf(key).hidden, key).toBeFalsy();
		}
		for (const key of LEGACY) {
			expect(
				(SETTINGS_SCHEMA as Record<string, unknown>)[key],
				`${key} must stay defined for old configs`,
			).toBeDefined();
			expect(uiOf(key).hidden, key).toBe(true);
		}
	});

	it("keeps every unified control desktop-effective", () => {
		// The rewrite model is now served to the desktop over tts.rewrite, so
		// none of the read-aloud controls may be folded into the TUI-only block.
		for (const key of ["tts.autoRead", "tts.readMode", "tts.enhanced", "tts.localVoice"] as const) {
			expect(uiOf(key).tuiOnly, key).toBeFalsy();
		}
	});

	it("falls back to a legacy speech.* value when the tts.* key was never written", () => {
		const s = Settings.isolated({
			"speech.enabled": true,
			"speech.mode": "yield",
			"speech.enhanced": true,
			"speech.voice": "af_heart",
		});
		expect(s.get("tts.autoRead")).toBe(true);
		expect(s.get("tts.readMode")).toBe("yield");
		expect(s.get("tts.enhanced")).toBe(true);
		expect(s.get("tts.localVoice")).toBe("af_heart");
	});

	it("prefers the unified key once it is written", () => {
		const s = Settings.isolated({
			"speech.enabled": true,
			"speech.mode": "all",
			"tts.autoRead": false,
			"tts.readMode": "yield",
		});
		expect(s.get("tts.autoRead")).toBe(false);
		expect(s.get("tts.readMode")).toBe("yield");
	});

	it("keeps schema defaults when neither key was written", () => {
		const s = Settings.isolated({});
		expect(s.get("tts.autoRead")).toBe(false);
		expect(s.get("tts.readMode")).toBe("assistant");
		expect(s.get("tts.enhanced")).toBe(false);
	});
});
