/**
 * Example MusePi plugin package.
 *
 * A plugin package is the unit a profile stacks (see `dsh.profile.bundles`):
 * one npm package that contributes capabilities at load time, rather than a
 * static entry in the host's built-in registry. This one shows the whole
 * surface a plugin can use:
 *
 * - **`pi.registerMagicKeyword`** — a composer keyword with a hidden notice,
 *   the same contract the three compiled-in keywords have.
 * - **`pi.registerComponent`** — its own settings panel in the GUI.
 * - **`pi.registerRpc`** — a daemon-side method the panel calls back into.
 *
 * The notice text lives in `prompts/deepdive-notice.md` and is imported as a
 * static asset: prompts belong in files, not in code.
 */
import type { ExtensionAPI } from "../../src/extensibility/extensions/types";
import deepdiveNotice from "./prompts/deepdive-notice.md" with { type: "text" };

const KEYWORD_NAME = "deepdive";

export default function deepdiveKeyword(pi: ExtensionAPI): void {
	pi.setLabel("Deepdive Keyword");

	// The keyword: a standalone word in the composer that appends a hidden
	// notice on submit. Enabled only when its own setting is on — see the
	// panel below and the `magicKeywords.deepdive` key it writes.
	pi.registerMagicKeyword({
		name: KEYWORD_NAME,
		description: "在输入框里单独输入 deepdive，即请求一次带证据链的深度分析",
		notice: deepdiveNotice.trim(),
		noticeType: "deepdive-notice",
		// Editor gradient, the same affordance the built-in keywords have: the
		// word paints itself cyan→indigo as you type, so it reads as active.
		highlight: { from: 190, to: 265 },
	});

	// A settings panel, so the keyword has a switch like any built-in. Two
	// slots: a full page in the settings window, and the panel embedded in the
	// plugin's detail dialog.
	pi.registerComponent({
		slot: "settings.tab.deepdive",
		moduleUrl: "./ui/panel.tsx",
		label: "Deepdive",
		order: 60,
	});
	pi.registerComponent({
		slot: "settings.extensions",
		moduleUrl: "./ui/panel.tsx",
		label: "Deepdive",
		order: 60,
	});

	// The panel's callback channel. Runs in the daemon's extension context:
	// computation is fine, session-bound actions are not wired here.
	pi.registerRpc("deepdive.describe", () => ({
		keyword: KEYWORD_NAME,
		settingKey: `magicKeywords.${KEYWORD_NAME}`,
		noticeChars: deepdiveNotice.trim().length,
	}));

	pi.logger.info(`[deepdive] keyword plugin loaded (${KEYWORD_NAME})`);
}
