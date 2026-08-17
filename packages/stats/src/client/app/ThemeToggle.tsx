import { type LucideIcon, Monitor, Moon, Sun } from "lucide-react";
import { t } from "../i18n";
import { type ThemePreference, useThemePreference } from "../useSystemTheme";

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

const PREFERENCE_LABEL: Record<ThemePreference, string> = {
	system: "System theme",
	light: "Light theme",
	dark: "Dark theme",
};

export function ThemeToggle() {
	const { preference, setPreference } = useThemePreference();
	const Icon = PREFERENCE_ICON[preference];

	return (
		<button
			type="button"
			className="stats-theme-toggle"
			onClick={() => setPreference(NEXT_PREFERENCE[preference])}
			aria-label={t("{0} (click to switch)", t(PREFERENCE_LABEL[preference]))}
			title={t("{0} — click to switch", t(PREFERENCE_LABEL[preference]))}
		>
			<Icon size={16} />
		</button>
	);
}
