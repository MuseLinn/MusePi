import type { ReactNode } from "react";
import { t } from "../i18n/index.js";
import { SendChip } from "./send";

/**
 * Calc widget — labor-fee tax calculator (kimi calculator pattern):
 * pre/post-tax toggle + input + progress bar + 2×2 semantic data cards +
 * applicable rules. Fixed rule: single payment ≤ 4000 CNY.
 */
function compute(mode: string, amount: number): { gross: number; tax: number; net: number; rate: number } {
	if (mode === "pre") {
		// 税前 → 税后: tax = gross * 0.2, net = gross * 0.8 + 160? No —
		// 规则: taxable = income - 800, tax = taxable * 20%.
		const taxable = Math.max(0, amount - 800);
		const tax = taxable * 0.2;
		return { gross: amount, tax, net: amount - tax, rate: amount > 0 ? (tax / amount) * 100 : 0 };
	}
	// 税后 → 税前: net = gross - (gross - 800) * 0.2 = gross * 0.8 + 160
	const gross = (amount - 160) / 0.8;
	const tax = Math.max(0, gross - amount);
	const rate = gross > 0 ? (tax / gross) * 100 : 0;
	return { gross, tax, net: amount, rate };
}

export function CalcCard({
	data,
	update,
	sendPrompt,
}: {
	data: Record<string, unknown>;
	update(patch: Record<string, unknown>): void;
	sendPrompt?(text: string): void;
}): ReactNode {
	const mode = data.mode === "pre" ? "pre" : "post";
	const amount = typeof data.amount === "number" ? data.amount : 1760;
	const r = compute(mode, amount);
	const pct = Math.min(100, Math.max(0, (r.net / (r.gross || 1)) * 100));

	return (
		<div className="gui-widget-calc">
			<div className="gui-widget-calc-toggles">
				<button
					type="button"
					className={`gui-widget-calc-toggle${mode === "pre" ? " gui-widget-calc-toggle--active" : ""}`}
					onClick={() => update({ mode: "pre" })}
				>
					{t("widget pre-tax")}
				</button>
				<button
					type="button"
					className={`gui-widget-calc-toggle${mode === "post" ? " gui-widget-calc-toggle--active" : ""}`}
					onClick={() => update({ mode: "post" })}
				>
					{t("widget post-tax")}
				</button>
			</div>
			<input
				type="number"
				className="gui-widget-calc-input"
				value={amount}
				min={0}
				onChange={e => update({ amount: Number(e.target.value) || 0 })}
			/>
			<div className="gui-widget-calc-bar">
				<div className="gui-widget-calc-bar-fill" style={{ width: `${pct}%` }} />
				<span className="gui-widget-calc-bar-label">
					{t("widget take-home")} {pct.toFixed(1)}%
				</span>
			</div>
			<div className="gui-widget-calc-grid">
				<div className="gui-widget-calc-cell">
					<span className="gui-widget-calc-cell-label">{t("widget gross")}</span>
					<span className="gui-widget-calc-cell-val">{r.gross.toFixed(2)}</span>
				</div>
				<div className="gui-widget-calc-cell gui-widget-calc-cell--tax">
					<span className="gui-widget-calc-cell-label">{t("widget tax")}</span>
					<span className="gui-widget-calc-cell-val">{r.tax.toFixed(2)}</span>
				</div>
				<div className="gui-widget-calc-cell gui-widget-calc-cell--net">
					<span className="gui-widget-calc-cell-label">{t("widget net")}</span>
					<span className="gui-widget-calc-cell-val">{r.net.toFixed(2)}</span>
				</div>
				<div className="gui-widget-calc-cell">
					<span className="gui-widget-calc-cell-label">{t("widget rate")}</span>
					<span className="gui-widget-calc-cell-val">{r.rate.toFixed(2)}%</span>
				</div>
			</div>
			<div className="gui-widget-calc-rules">
				<div className="gui-widget-calc-rules-title">{t("widget rules")}</div>
				<div className="gui-widget-calc-rule">
					<span>{t("widget taxable")}</span>
					<span className="gui-widget-calc-rule-val">{t("widget income minus 800")}</span>
				</div>
				<div className="gui-widget-calc-rule">
					<span>{t("widget rate label")}</span>
					<span className="gui-widget-calc-rule-val">20%</span>
				</div>
			</div>

			<SendChip
				text={`${t("widget gross")} ${r.gross.toFixed(2)} → ${t("widget net")} ${r.net.toFixed(2)}（${t("widget rate")} ${r.rate.toFixed(1)}%）`}
				onSend={sendPrompt}
			/>
		</div>
	);
}
