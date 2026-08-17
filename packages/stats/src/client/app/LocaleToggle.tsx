import { Languages } from "lucide-react";
import { setLocale, t } from "../i18n";
import { useLocale } from "../i18n/use-locale";

/** Toggle between en-US and zh-CN. Shows the current language (中文 / EN). */
export function LocaleToggle() {
	const locale = useLocale();
	const label = locale === "zh-CN" ? "中文" : "EN";
	const next = locale === "zh-CN" ? "en-US" : "zh-CN";

	return (
		<button
			type="button"
			onClick={() => setLocale(next)}
			className="inline-flex items-center justify-center gap-1 h-8 px-2.5 flex-shrink-0 border rounded-md bg-[var(--surface)] text-[var(--muted)] text-xs font-semibold cursor-pointer hover:text-[var(--text)] hover:border-[var(--border-strong)] transition-colors"
			aria-label={t("Switch language")}
			title={t("Switch language")}
		>
			<Languages size={14} />
			<span>{label}</span>
		</button>
	);
}
