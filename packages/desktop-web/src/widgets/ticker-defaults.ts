/** Ticker widget default board data (kimi ticker pattern). */
export function tickerDefaults(): Record<string, unknown> {
	return {
		label: "EUR / CNY",
		value: "7.7945",
		delta: 0.0046,
		spark: [7.7, 7.72, 7.69, 7.74, 7.76, 7.75, 7.79, 7.78, 7.8],
	};
}
