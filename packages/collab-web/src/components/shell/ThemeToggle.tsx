import { type LucideIcon, Monitor, Moon, Sun } from "lucide-react";
import { t } from "../../i18n/index.js";
import { type ThemePreference, useThemePreference } from "../../lib/theme";

const NEXT_PREFERENCE: Record<ThemePreference, ThemePreference> = {
	system: "light",
	light: "dark",
	dark: "system",
};

const PREFERENCE_ICON: Record<ThemePreference, LucideIcon> = {
	system: Monitor,
	light: Sun,
	dark: Moon,
};

const PREFERENCE_LABEL = {
	system: "System theme",
	light: "Light theme",
	dark: "Dark theme",
} as const satisfies Record<ThemePreference, string>;

export function ThemeToggle() {
	const { preference, setPreference } = useThemePreference();
	const Icon = PREFERENCE_ICON[preference];
	const label = PREFERENCE_LABEL[preference];
	const translatedLabel = t(label);

	return (
		<button
			type="button"
			className="sh-theme-toggle"
			onClick={() => setPreference(NEXT_PREFERENCE[preference])}
			aria-label={t("{name} (click to switch)", { name: translatedLabel })}
			title={t("{name} — click to switch", { name: translatedLabel })}
		>
			<Icon size={16} />
		</button>
	);
}
