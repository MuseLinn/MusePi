import type { ReactNode } from "react";
import { t } from "../../i18n/index.js";
import { ACCENT_PRESETS, useAccentPreference } from "../../lib/theme.js";

const PRESET_LABEL: Record<string, string> = {
	brand: "Brand pink",
	mono: "Monochrome",
	ocean: "Ocean blue",
	jade: "Jade green",
};

/**
 * Accent-axis toggle — orthogonal to the light/dark scheme (mirrors the
 * desktop GUI's AccentToggle: opencode theme × data-color-scheme split).
 * Cycles the accent presets; the custom color stays desktop-settings-only.
 */
export function AccentToggle(): ReactNode {
	const { accent, setAccent } = useAccentPreference();
	const current = ACCENT_PRESETS.find(p => p.id === accent) ?? ACCENT_PRESETS[0];
	const next =
		ACCENT_PRESETS[(ACCENT_PRESETS.findIndex(p => p.id === accent) + 1) % ACCENT_PRESETS.length] ?? ACCENT_PRESETS[0];
	const title = `${PRESET_LABEL[current.id] ?? current.id} — ${t("click for {name}", { name: PRESET_LABEL[next.id] ?? next.id })}`;
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
