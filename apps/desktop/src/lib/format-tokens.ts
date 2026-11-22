/** Compact token count (K/M) shared by the context readouts (ring popover,
 *  /context card, threshold control). */
export function formatTokenCount(n: number | null | undefined): string {
	if (n == null) return "—";
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1000) return `${Math.round(n / 1000)}K`;
	return String(n);
}
