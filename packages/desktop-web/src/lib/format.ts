/** Small pure formatting helpers shared across desktop-web components. */
import { t } from "../i18n/index.js";

/** "950", "12.3k", "1.2M" — tolerant of non-finite input. */
export function fmtTokens(n: number): string {
	if (!Number.isFinite(n) || n <= 0) return "0";
	if (n < 1000) return String(Math.round(n));
	if (n < 1_000_000) {
		const k = n / 1000;
		return `${k >= 100 ? Math.round(k) : k.toFixed(1)}k`;
	}
	const m = n / 1_000_000;
	return `${m >= 100 ? Math.round(m) : m.toFixed(1)}M`;
}

/** "$0.004", "$0.42", "$4.20" — tolerant of non-finite input. */
export function fmtCost(usd: number): string {
	if (!Number.isFinite(usd) || usd <= 0) return "$0.00";
	return `$${usd >= 1 ? usd.toFixed(2) : usd.toFixed(3)}`;
}

/** "847ms", "12.3s", "4m05s", "1h12m". */
export function fmtDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "0ms";
	if (ms < 1000) return `${Math.round(ms)}ms`;
	const s = ms / 1000;
	if (s < 60) return `${s.toFixed(1)}s`;
	const min = Math.floor(s / 60);
	if (min < 60) return `${min}m${String(Math.round(s % 60)).padStart(2, "0")}s`;
	const h = Math.floor(min / 60);
	return `${h}h${String(min % 60).padStart(2, "0")}m`;
}

/** "now", "42s ago", "5m ago", "3h ago", "2d ago". Input: epoch ms. */
export function relTime(tsMs: number): string {
	if (!Number.isFinite(tsMs)) return "";
	const delta = Date.now() - tsMs;
	if (delta < 10_000) return t("now");
	const s = Math.floor(delta / 1000);
	if (s < 60) return t("{count}s ago", { count: String(s) });
	const min = Math.floor(s / 60);
	if (min < 60) return t("{count}m ago", { count: String(min) });
	const h = Math.floor(min / 60);
	if (h < 24) return t("{count}h ago", { count: String(h) });
	return t("{count}d ago", { count: String(Math.floor(h / 24)) });
}

/** "73%" from a 0–100 percent; em dash for null/non-finite. */
export function fmtPercent(p: number | null | undefined): string {
	if (p === null || p === undefined || !Number.isFinite(p)) return "—";
	return `${Math.round(Math.min(100, Math.max(0, p)))}%`;
}

/** "just now", "5 min ago", "3 h ago", "2 d ago" — collab workspace timestamps.
 *  Input: epoch ms. Locale-aware via the session i18n keys (distinct from
 *  relTime's second-granularity set). */
export function formatWhen(ts: number): string {
	const delta = Date.now() - ts;
	if (delta < 60_000) return t("just now");
	const minutes = Math.floor(delta / 60_000);
	if (minutes < 60) return t("{count} min ago", { count: String(minutes) });
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return t("{count} h ago", { count: String(hours) });
	return t("{count} d ago", { count: String(Math.floor(hours / 24)) });
}

/**
 * Home-relative, middle-elided path: "~/…/packages/desktop-web".
 *
 * Folds `/Users/<x>` / `/home/<x>` → `~` AND collapses middle segments
 * when the path has >4 components. For the fold-only variant (no elision)
 * used in tool cards, see `homePath` in `tool-render/util.ts`.
 */
export function shortenPath(p: string): string {
	if (typeof p !== "string" || p.length === 0) return "";
	let out = p.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~");
	const segs = out.split("/");
	if (segs.length > 4) out = `${segs[0]}/…/${segs.slice(-2).join("/")}`;
	return out;
}

/** Tolerant text extraction from string | content-block array | message-like objects. */
export function messageText(m: unknown): string {
	if (typeof m === "string") return m;
	if (m === null || m === undefined) return "";
	if (Array.isArray(m)) {
		const parts: string[] = [];
		for (const block of m) {
			if (typeof block === "string") {
				parts.push(block);
				continue;
			}
			if (block && typeof block === "object") {
				const rec = block as Record<string, unknown>;
				if (typeof rec.text === "string") parts.push(rec.text);
				else if (typeof rec.thinking === "string") parts.push(rec.thinking);
			}
		}
		return parts.join("\n");
	}
	if (typeof m === "object") {
		const rec = m as Record<string, unknown>;
		if (typeof rec.text === "string") return rec.text;
		if ("content" in rec) return messageText(rec.content);
	}
	return "";
}
