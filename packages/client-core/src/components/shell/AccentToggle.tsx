import type { ReactNode } from "react";
import { t } from "../../i18n/index.js";
import { ACCENT_PRESETS, useAccentPreference } from "../../lib/theme.js";

/**
 * Accent-axis toggle — orthogonal to the light/dark scheme (mirrors the
 * desktop GUI's AccentToggle: opencode theme × data-color-scheme split).
 * Cycles the accent presets; the custom color stays desktop-settings-only.
 * Labels come from `ACCENT_PRESETS` (the single registry shared with the
 * desktop settings), so adding the follow-theme preset did not duplicate
 * product copy here.
 */
export function AccentToggle(): ReactNode {
	const { accent, setAccent } = useAccentPreference();
	const current = ACCENT_PRESETS.find(p => p.id === accent) ?? ACCENT_PRESETS[0];
	const next =
		ACCENT_PRESETS[(ACCENT_PRESETS.findIndex(p => p.id === accent) + 1) % ACCENT_PRESETS.length] ?? ACCENT_PRESETS[0];
	const title = `${current.label} — ${t("shell.clickForWithName", { name: next.label })}`;
	return (
		<button
			type="button"
			className="sh-theme-toggle"
			onClick={() => setAccent(next.id)}
			aria-label={title}
			title={title}
		>
			<span className="sh-accent-dot" style={{ background: `var(--accent)` }} aria-hidden="true" />
		</button>
	);
}
