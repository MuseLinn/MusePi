import { t } from "@musepi/collab-web";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";

/**
 * App-styled accent color picker — replaces the native `<input type="color">`
 * popup (settings custom-accent swatch + onboarding custom card). This file
 * only carries the PANEL content; the frosted popover shell, positioning and
 * enter/exit animation come from `useFloatingMenu` at the call site
 * (className "gui-color-picker" → styled in gui.css).
 */

// ── Color math (hex ↔ HSV, WCAG contrast) — zero dependencies ──────────

function hexToRgb(hex: string): [number, number, number] | null {
	const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
	if (!m) return null;
	const n = Number.parseInt(m[1]!, 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex(r: number, g: number, b: number): string {
	const c = (v: number): string =>
		Math.max(0, Math.min(255, Math.round(v)))
			.toString(16)
			.padStart(2, "0");
	return `#${c(r)}${c(g)}${c(b)}`;
}

interface HSV {
	h: number;
	s: number;
	v: number;
}

function rgbToHsv(r: number, g: number, b: number): HSV {
	const rn = r / 255;
	const gn = g / 255;
	const bn = b / 255;
	const max = Math.max(rn, gn, bn);
	const min = Math.min(rn, gn, bn);
	const d = max - min;
	let h = 0;
	if (d !== 0) {
		if (max === rn) h = ((gn - bn) / d) % 6;
		else if (max === gn) h = (bn - rn) / d + 2;
		else h = (rn - gn) / d + 4;
		h *= 60;
		if (h < 0) h += 360;
	}
	return { h, s: max === 0 ? 0 : d / max, v: max };
}

function hsvToRgb({ h, s, v }: HSV): [number, number, number] {
	const c = v * s;
	const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
	const m = v - c;
	let rgb: [number, number, number] = [0, 0, 0];
	if (h < 60) rgb = [c, x, 0];
	else if (h < 120) rgb = [x, c, 0];
	else if (h < 180) rgb = [0, c, x];
	else if (h < 240) rgb = [0, x, c];
	else if (h < 300) rgb = [x, 0, c];
	else rgb = [c, 0, x];
	return [(rgb[0] + m) * 255, (rgb[1] + m) * 255, (rgb[2] + m) * 255];
}

function hexToHsv(hex: string): HSV {
	const rgb = hexToRgb(hex);
	return rgb ? rgbToHsv(rgb[0], rgb[1], rgb[2]) : { h: 0, s: 0, v: 1 };
}

function normalizeHex(raw: string): string | null {
	const m = /^#?([0-9a-f]{6})$/i.exec(raw.trim());
	return m ? `#${m[1]!.toLowerCase()}` : null;
}

/** WCAG 2.1 relative luminance of a hex color (0..1). */
function relativeLuminance(hex: string): number {
	const rgb = hexToRgb(hex);
	if (!rgb) return 0;
	const lin = (c: number): number => {
		const s = c / 255;
		return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
}

function contrastRatio(a: string, b: string): number {
	const la = relativeLuminance(a);
	const lb = relativeLuminance(b);
	const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
	return (hi + 0.05) / (lo + 0.05);
}

/** Resolve any CSS color (incl. the oklch design tokens) to hex via a
 *  1px canvas readback. */
function cssColorToHex(css: string): string {
	try {
		const canvas = document.createElement("canvas");
		canvas.width = 1;
		canvas.height = 1;
		const ctx = canvas.getContext("2d");
		if (!ctx) return "#17181c";
		ctx.fillStyle = css;
		ctx.fillRect(0, 0, 1, 1);
		const d = ctx.getImageData(0, 0, 1, 1).data;
		return rgbToHex(d[0], d[1], d[2]);
	} catch {
		return "#17181c";
	}
}

/** Quick-pick dots: the four preset accent colors (same values as the
 *  settings swatch row — brand emerald / mono / ocean / jade). */
const PRESET_HEXES = ["#34d399", "#8a8a93", "#38bdf8", "#44b782"] as const;

export function ColorPickerPanel({
	value,
	onChange,
	onApply,
}: {
	value: string;
	onChange: (hex: string) => void;
	/** 「应用」:apply the color (full-screen veil + morphicon, preset-switch
	 *  experience). Optional — hidden when absent. */
	onApply?: (hex: string) => void;
}): ReactNode {
	const hsv = useMemo(() => hexToHsv(value), [value]);
	// Last chromatic hue survives dragging into gray/black — the SV field
	// and hue slider both fall back to it while the color is achromatic.
	const lastHueRef = useRef(hsv.h);
	if (hsv.s > 0.02 && hsv.v > 0.02) lastHueRef.current = hsv.h;
	const fieldHue = hsv.s > 0.02 && hsv.v > 0.02 ? hsv.h : lastHueRef.current;

	const svRef = useRef<HTMLDivElement | null>(null);
	const hueRef = useRef<HTMLDivElement | null>(null);

	const svFromPointer = (e: React.PointerEvent<HTMLDivElement>): void => {
		const el = svRef.current;
		if (!el) return;
		const rect = el.getBoundingClientRect();
		const x = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
		const y = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
		const [r, g, b] = hsvToRgb({ h: fieldHue, s: x, v: 1 - y });
		onChange(rgbToHex(r, g, b));
	};
	const hueFromPointer = (e: React.PointerEvent<HTMLDivElement>): void => {
		const el = hueRef.current;
		if (!el) return;
		const rect = el.getBoundingClientRect();
		const h = Math.min(360, Math.max(0, ((e.clientX - rect.left) / rect.width) * 360));
		const [r, g, b] = hsvToRgb({ h, s: hsv.s, v: hsv.v });
		onChange(rgbToHex(r, g, b));
	};

	// Hex text draft — local so typing isn't fought by the controlled value;
	// commits on Enter/blur only when valid (else reverts). External changes
	// (SV/hue drag, preset click) sync in while the field isn't focused.
	const [hexDraft, setHexDraft] = useState(() => normalizeHex(value) ?? value);
	const hexInputRef = useRef<HTMLInputElement | null>(null);
	useEffect(() => {
		if (document.activeElement !== hexInputRef.current) setHexDraft(value);
	}, [value]);
	const commitHex = (): void => {
		const next = normalizeHex(hexDraft);
		if (next) {
			setHexDraft(next);
			onChange(next);
		} else {
			setHexDraft(value);
		}
	};

	const rgb = hexToRgb(value) ?? [0, 0, 0];
	const commitChannel = (i: number, raw: string): void => {
		const v = Number(raw);
		if (!Number.isFinite(v)) return;
		const next = [...rgb] as [number, number, number];
		next[i] = Math.max(0, Math.min(255, v));
		onChange(rgbToHex(next[0], next[1], next[2]));
	};

	// App background (--color-bg, resolved through the oklch token) — the
	// surface the accent reads against, so the contrast grade is real.
	const bgHex = useMemo(() => {
		const css = getComputedStyle(document.documentElement).getPropertyValue("--color-bg").trim();
		return css ? cssColorToHex(css) : "#17181c";
	}, []);
	const ratio = useMemo(() => contrastRatio(value, bgHex), [value, bgHex]);

	return (
		// Card surface lives HERE — the useFloatingMenu call sites must NOT
		// pass a className (the portal wrapper would double-draw this rounded
		// frosted card behind it; WelcomeComposer quota-panel lesson).
		<div className="gui-color-picker">
			<div
				ref={svRef}
				className="gui-cp-field"
				role="slider"
				aria-label={t("pick color")}
				aria-valuetext={value}
				onPointerDown={e => {
					e.currentTarget.setPointerCapture(e.pointerId);
					svFromPointer(e);
				}}
				onPointerMove={e => {
					if (e.buttons & 1) svFromPointer(e);
				}}
			>
				<div className="gui-cp-field-hue" style={{ background: `hsl(${fieldHue} 100% 50%)` }} />
				<div className="gui-cp-field-s" />
				<div className="gui-cp-field-v" />
				<span className="gui-cp-field-handle" style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%` }} />
			</div>
			<div
				ref={hueRef}
				className="gui-cp-hue"
				role="slider"
				aria-label={t("hue")}
				aria-valuenow={Math.round(fieldHue)}
				aria-valuemin={0}
				aria-valuemax={360}
				onPointerDown={e => {
					e.currentTarget.setPointerCapture(e.pointerId);
					hueFromPointer(e);
				}}
				onPointerMove={e => {
					if (e.buttons & 1) hueFromPointer(e);
				}}
			>
				<span className="gui-cp-hue-handle" style={{ left: `${(fieldHue / 360) * 100}%` }} />
			</div>
			<div className="gui-cp-inputs">
				<label className="gui-cp-input">
					<span>HEX</span>
					<input
						ref={hexInputRef}
						value={hexDraft}
						onChange={e => setHexDraft(e.target.value)}
						onBlur={commitHex}
						onKeyDown={e => {
							if (e.key === "Enter") e.currentTarget.blur();
						}}
						spellCheck={false}
						autoComplete="off"
						aria-label="HEX"
					/>
				</label>
				{(["r", "g", "b"] as const).map((ch, i) => (
					<label key={ch} className="gui-cp-input">
						<span>{ch.toUpperCase()}</span>
						<input
							type="number"
							min={0}
							max={255}
							defaultValue={rgb[i]}
							onBlur={e => commitChannel(i, e.target.value)}
							onKeyDown={e => {
								if (e.key === "Enter") e.currentTarget.blur();
							}}
							aria-label={ch.toUpperCase()}
						/>
					</label>
				))}
			</div>
			<div className="gui-cp-presets">
				<span className="gui-cp-label">{t("preset colors")}</span>
				{PRESET_HEXES.map(c => (
					<button
						key={c}
						type="button"
						className={`gui-cp-preset${value.toLowerCase() === c ? " gui-cp-preset--active" : ""}`}
						style={{ background: c }}
						title={c}
						aria-label={c}
						onClick={() => onChange(c)}
					/>
				))}
			</div>
			<div className="gui-cp-contrast">
				<span>{t("background contrast")}</span>
				<span
					className={`gui-cp-contrast-grade${ratio >= 4.5 ? " gui-cp-contrast-grade--ok" : " gui-cp-contrast-grade--bad"}`}
				>
					{ratio >= 7 ? "AAA" : ratio >= 4.5 ? "AA" : t("contrast low")} · {ratio.toFixed(1)}:1
				</span>
			</div>
			{onApply && (
				<div className="gui-cp-actions">
					<button type="button" className="gui-cp-btn gui-cp-btn--primary" onClick={() => onApply(value)}>
						{t("apply")}
					</button>
				</div>
			)}
		</div>
	);
}
