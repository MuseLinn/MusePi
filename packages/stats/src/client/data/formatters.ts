import { formatDistanceToNow } from "date-fns";
import { zhCN } from "date-fns/locale/zh-CN";
import { getLocaleSnapshot } from "../i18n";

/**
 * Current UI locale ("zh-CN" | "en-US"). Formatters read it at call time;
 * every call site is render or chart-draw time, so the snapshot is always
 * fresh. Components re-render on locale change via the App-level locale
 * subscription.
 */
function uiLocale(): string {
	return getLocaleSnapshot();
}

export function formatInteger(value: number): string {
	return value.toLocaleString(uiLocale());
}

/**
 * Compact magnitude for token counts — deliberately locale-independent and
 * always en-US K/M/B compact (18万 never appears, even in the Chinese UI):
 * token units follow the universal K/M/B convention like cost stays in $.
 */
export function formatCompact(value: number): string {
	return value.toLocaleString("en-US", { notation: "compact" });
}

export function formatCost(value: number, digits?: number): string {
	if (value === 0) return "$0";
	const fractionDigits = digits !== undefined ? digits : value > 0 && value < 0.01 ? 4 : 2;
	return `$${value.toLocaleString(uiLocale(), {
		minimumFractionDigits: fractionDigits,
		maximumFractionDigits: fractionDigits,
	})}`;
}

export function formatPercent(value: number, digits = 1): string {
	return `${(value * 100).toFixed(digits)}%`;
}

export function formatDurationMs(value: number | null, digits?: number): string {
	if (value === null) return "-";
	const sec = value / 1000;
	const d = digits !== undefined ? digits : sec < 1 ? 2 : 1;
	return `${sec.toFixed(d)}s`;
}

export function formatTokensPerSecond(value: number | null): string {
	if (value === null) return "-";
	return value.toFixed(1);
}

/**
 * Relative time in the UI locale. date-fns defaults to en-US, which is why
 * this must pass the locale explicitly; `undefined` for en-US keeps the
 * default behavior (and avoids pulling en-US's locale module into the bundle).
 */
export function formatRelativeTime(timestamp: number): string {
	return formatDistanceToNow(new Date(timestamp), {
		addSuffix: true,
		locale: uiLocale() === "zh-CN" ? zhCN : undefined,
	});
}

export function formatBytes(value: number): string {
	if (value >= 1e9) return `${(value / 1e9).toFixed(1)} GB`;
	if (value >= 1e6) return `${(value / 1e6).toFixed(1)} MB`;
	if (value >= 1e3) return `${(value / 1e3).toFixed(1)} KB`;
	return `${value} B`;
}
