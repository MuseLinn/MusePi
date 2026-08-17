import { ACCENT_PRESETS, type AccentPreference, useAccentPreference } from "@musepi/desktop-web";
import { CircleDot, Moon, Palette, Waves } from "lucide-react";

const PRESET_ICON: Partial<Record<AccentPreference, typeof Palette>> = {
	brand: Palette,
	mono: CircleDot,
	ocean: Waves,
	jade: Moon,
};

/**
 * Accent-axis toggle — orthogonal to the light/dark scheme, mirroring
 * opencode's theme × data-color-scheme split. Cycles the accent presets
 * (brand pink / mono / ocean blue / jade green); each preset's foreground is
 * derived from the active scheme, never a fixed color (kimi #2083). The
 * custom color is managed from the settings panel, not this cycle.
 */
export function AccentToggle() {
	const { accent, setAccent } = useAccentPreference();
	const current = ACCENT_PRESETS.find(p => p.id === accent) ?? ACCENT_PRESETS[0];
	const next =
		ACCENT_PRESETS[(ACCENT_PRESETS.findIndex(p => p.id === accent) + 1) % ACCENT_PRESETS.length] ?? ACCENT_PRESETS[0];
	const Icon = PRESET_ICON[accent] ?? Palette;
	const title = `${current.label} — click for ${next.label}`;
	return (
		<button
			type="button"
			className="sh-theme-toggle"
			onClick={() => setAccent(next.id)}
			aria-label={title}
			title={title}
		>
			<Icon size={16} />
		</button>
	);
}
