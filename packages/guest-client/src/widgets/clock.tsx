import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { t } from "../i18n/index.js";

/**
 * Clock widget — market-style digital clock with three market states
 * (US open / EU open / CN open), kimi MARKET PULSE parity. Pure local
 * time rendering; 1s tick.
 */
function marketState(market: string): { label: string; open: boolean } {
	const now = new Date();
	const utcH = now.getUTCHours() + now.getUTCMinutes() / 60;
	switch (market) {
		case "us": {
			// 09:30–16:00 ET = 13:30–20:00 UTC (EDT)
			const et = (utcH - 4 + 24) % 24;
			return { label: "US", open: et >= 9.5 && et < 16 };
		}
		case "eu": {
			// 09:00–17:30 CET = 08:00–16:30 UTC (CEST)
			return { label: "EU", open: utcH >= 8 && utcH < 16.5 };
		}
		default: {
			// 09:30–15:00 CST = 01:30–07:00 UTC
			return { label: "CN", open: utcH >= 1.5 && utcH < 7 };
		}
	}
}

export function ClockCard({
	data,
	update,
}: {
	data: Record<string, unknown>;
	update(patch: Record<string, unknown>): void;
}): ReactNode {
	const [now, setNow] = useState(() => new Date());
	useEffect(() => {
		const id = window.setInterval(() => setNow(new Date()), 1000);
		return () => window.clearInterval(id);
	}, []);

	const market = typeof data.market === "string" ? data.market : "cn";
	const m = marketState(market);
	const hh = String(now.getHours()).padStart(2, "0");
	const mm = String(now.getMinutes()).padStart(2, "0");
	const ss = String(now.getSeconds()).padStart(2, "0");

	return (
		<div className="gui-widget-clock">
			<div className="gui-widget-clock-time">
				{hh}
				<span className="gui-widget-clock-colon">:</span>
				{mm}
				<span className="gui-widget-clock-colon">:</span>
				{ss}
			</div>
			<div className="gui-widget-clock-row">
				{[
					["cn", "CN"],
					["us", "US"],
					["eu", "EU"],
				].map(([id, label]) => {
					const st = marketState(id);
					return (
						<button
							key={id}
							type="button"
							className={`gui-widget-clock-market${market === id ? " gui-widget-clock-market--active" : ""}`}
							onClick={() => update({ market: id })}
						>
							<span className={`gui-widget-dot${st.open ? " gui-widget-dot--open" : ""}`} />
							{label}
							<span className="gui-widget-clock-state">{st.open ? t("open") : t("closed")}</span>
						</button>
					);
				})}
			</div>
		</div>
	);
}
