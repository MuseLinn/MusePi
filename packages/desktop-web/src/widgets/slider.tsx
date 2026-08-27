import type { ReactNode } from "react";
import { useState } from "react";
import { type TranslationKey, t } from "../i18n/index.js";
import { SendChip } from "./send";

/**
 * Slider widget — kimi eye-lab pattern: N parameter sliders with live
 * values and a simple derived readout (here: a damped sine "signal" whose
 * noise/jitter sliders visibly corrupt it). Demonstrates the SliderCard
 * pattern the widget design system targets.
 */
const PARAMS: Array<{ key: string; min: number; max: number; step: number; labelKey: string }> = [
	{ key: "noise", min: 0, max: 1, step: 0.01, labelKey: "widget noise" },
	{ key: "jitter", min: 0, max: 1, step: 0.01, labelKey: "widget jitter" },
	{ key: "freq", min: 0.5, max: 6, step: 0.1, labelKey: "widget frequency" },
	{ key: "amp", min: 0.1, max: 2, step: 0.05, labelKey: "widget amplitude" },
];

export function SliderCard({
	data,
	update,
	sendPrompt,
}: {
	data: Record<string, unknown>;
	update(patch: Record<string, unknown>): void;
	sendPrompt?(text: string): void;
}): ReactNode {
	const [, setTick] = useState(0);
	const noise = typeof data.noise === "number" ? data.noise : 0.2;
	const jitter = typeof data.jitter === "number" ? data.jitter : 0.1;
	const freq = typeof data.freq === "number" ? data.freq : 2;
	const amp = typeof data.amp === "number" ? data.amp : 1;

	const points: string[] = [];
	for (let i = 0; i < 72; i++) {
		const x = (i / 71) * Math.PI * 2 * freq;
		const noiseV = (Math.random() - 0.5) * 2 * noise;
		const jitterV = (Math.random() - 0.5) * jitter;
		const y = 50 - Math.sin(x) * amp * 34 + noiseV * 34 + jitterV * 34;
		points.push(`${((i / 71) * 200).toFixed(1)},${y.toFixed(1)}`);
	}

	return (
		<div className="gui-widget-slider">
			<div className="gui-widget-slider-params">
				{PARAMS.map(p => {
					const v = typeof data[p.key] === "number" ? (data[p.key] as number) : 0;
					return (
						<div key={p.key} className="gui-widget-slider-row">
							<span className="gui-widget-slider-label">{t(p.labelKey as TranslationKey)}</span>
							<input
								type="range"
								min={p.min}
								max={p.max}
								step={p.step}
								value={v}
								onChange={e => {
									update({ [p.key]: Number(e.target.value) });
									setTick(x => x + 1); // redraw with fresh noise
								}}
							/>
							<span className="gui-widget-slider-val">{v.toFixed(2)}</span>
						</div>
					);
				})}
			</div>
			<svg viewBox="0 0 200 100" className="gui-widget-slider-plot" aria-hidden="true">
				<polyline points={points.join(" ")} fill="none" className="gui-widget-slider-line" />
			</svg>

			<SendChip
				text={`${t("widget noise")} ${noise} / ${t("widget jitter")} ${jitter} / ${t("widget frequency")} ${freq} / ${t("widget amplitude")} ${amp}`}
				onSend={sendPrompt}
			/>
		</div>
	);
}
