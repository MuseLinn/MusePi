import { type LucideIcon, Monitor, Moon, Sun } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { type TranslationKey, t } from "../../i18n/index.js";
import { type ThemePreference, useThemePreference } from "../../lib/theme";
import { Segmented, type SegmentedOption } from "./Segmented";

/** Follow-system / light / dark as a three-stop sliding switch — every mode
 * is one tap away (the old single button cycled system → light → dark and
 * forced two extra clicks to get back). Icons mirror the flip overlay's
 * morph targets. */
const THEME_OPTIONS: readonly { value: ThemePreference; label: TranslationKey; icon: LucideIcon }[] = [
	{ value: "system", label: "System theme", icon: Monitor },
	{ value: "light", label: "Light theme", icon: Sun },
	{ value: "dark", label: "Dark theme", icon: Moon },
];

export function ThemeToggle(): ReactNode {
	const { preference, setPreference } = useThemePreference();
	// Re-picking the active mode (theme.ts setThemePreference) emits
	// omp-theme-toggle-shake — jiggle the thumb instead of running another
	// flip overlay. Cleared on animationend (no timer: throttled
	// background-window timers would leave it stuck).
	const [shake, setShake] = useState(false);
	useEffect(() => {
		const on = (): void => {
			setShake(false);
			requestAnimationFrame(() => setShake(true));
		};
		window.addEventListener("omp-theme-toggle-shake", on);
		return () => window.removeEventListener("omp-theme-toggle-shake", on);
	}, []);
	// Translate inside render so a locale switch re-labels the segments.
	const options: SegmentedOption<ThemePreference>[] = THEME_OPTIONS.map(o => ({
		value: o.value,
		label: t(o.label),
		icon: o.icon,
	}));

	return (
		<Segmented
			iconOnly
			shake={shake}
			onShakeEnd={() => setShake(false)}
			ariaLabel={t("theme")}
			value={preference}
			options={options}
			onChange={setPreference}
		/>
	);
}
