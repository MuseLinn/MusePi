/**
 * Shared strings for the settings-page simulated conversation preview
 * (外观 / 语音 both render <MockConversationPreview>). The core translation
 * map lives in client-core (a frozen dependency of this package), so the
 * few shell-owned labels register here at module load via
 * `registerTranslations` — the same runtime seam plugins use. Keys are the
 * English source sentences; the zh-CN overlay maps them to Chinese and the
 * en-US overlay pins the source so both locales resolve identically to the
 * core map's contract.
 *
 * Import this file for side effects from MockConversationPreview.tsx.
 */
import { registerTranslations } from "@musepi/client-core";

const zhPreview = {
	"terminal behavior": "终端行为",
	"Affects the terminal (TUI) interface only; desktop settings live above":
		"以下选项仅作用于终端 (TUI) 界面，不影响桌面端",
} as const;

registerTranslations("zh-CN", zhPreview);

// en-US overlay: identity map — the t() fallback already returns the key, this
// just makes the registration symmetrical with the zh-CN overlay above.
// `satisfies` pins key parity: a zh key without an en entry (or vice versa)
// is a compile error, same contract the guest-client domain files enforce.
registerTranslations("en-US", {
	"terminal behavior": "terminal behavior",
	"Affects the terminal (TUI) interface only; desktop settings live above":
		"Affects the terminal (TUI) interface only; desktop settings live above",
} as const satisfies Record<keyof typeof zhPreview, string>);
