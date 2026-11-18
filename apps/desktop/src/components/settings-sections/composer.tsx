import { t } from "@musepi/client-core";
import type { ReactNode } from "react";
import { PASTE_IMAGE_MENTION_KEY } from "../../lib/composer-prefs";
import { PrefToggle } from "./chat";

/**
 * Settings → 输入框 (Kimi desktop parity): composer-scoped preferences.
 * The image toggle defaults ON — a pasted image becomes an `@图片N` token at
 * the caret, so the user sees the reference in the prose they are writing
 * and can delete it like any other token.
 */
export function ComposerSection(): ReactNode {
	return (
		<>
			<h2 className="gui-settings-page-title">{t("settings.composerSection")}</h2>
			<div className="gui-settings-section">
				<PrefToggle
					label={t("settings.pasteImageAutoMention")}
					description={t("settings.pasteImageAutoMentionHint")}
					storageKey={PASTE_IMAGE_MENTION_KEY}
					on
				/>
			</div>
		</>
	);
}
