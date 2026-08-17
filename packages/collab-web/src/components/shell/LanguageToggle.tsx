import { Languages } from "lucide-react";
import { setLocale, t } from "../../i18n/index.js";
import { useLocale } from "../../i18n/use-locale.js";

/** Language switch: toggles en-US / zh-CN, persisted to localStorage. */
export function LanguageToggle() {
	const locale = useLocale();
	const isZh = locale.toLowerCase().startsWith("zh");
	const next = isZh ? "en-US" : "zh-CN";
	const label = isZh ? t("Switch to English") : t("Switch to Chinese");

	return (
		<button
			type="button"
			className="sh-theme-toggle"
			onClick={() => setLocale(next)}
			aria-label={label}
			title={label}
		>
			<Languages size={13} />
			<span className="sh-lang-code">{isZh ? "EN" : "中"}</span>
		</button>
	);
}
