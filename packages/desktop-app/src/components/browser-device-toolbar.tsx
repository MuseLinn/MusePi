import { t } from "@musepi/client-core";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import type { BrowserDisplayScale } from "../lib/browser-viewport";
import { clampViewportSize } from "../lib/browser-viewport";

export const BROWSER_VIEWPORTS = [
	{ key: "tools.browserViewportFit", width: null, height: null, device: "fit" },
	{ key: "tools.browserViewportPhone", width: 393, height: 852, device: "phone" },
	{ key: "tools.browserViewportTablet", width: 768, height: 1024, device: "tablet" },
	{ key: "tools.browserViewportDesktop", width: 1440, height: 900, device: "desktop" },
] as const;

export type BrowserViewportPreset = (typeof BROWSER_VIEWPORTS)[number]["key"];
export type BrowserPageBackground = "auto" | "light" | "dark";

const SCALES = [0.25, 0.4, 0.5, 0.67, 0.75, 0.9, 1, 1.25, 1.5, 2] as const;

export function BrowserDeviceToolbar({
	preset,
	width,
	height,
	displayScale,
	background,
	onPresetChange,
	onSizeChange,
	onDisplayScaleChange,
	onBackgroundChange,
}: {
	preset: BrowserViewportPreset;
	width: number | null;
	height: number | null;
	displayScale: BrowserDisplayScale;
	background: BrowserPageBackground;
	onPresetChange(preset: BrowserViewportPreset): void;
	onSizeChange(size: { width: number; height: number }): void;
	onDisplayScaleChange(scale: BrowserDisplayScale): void;
	onBackgroundChange(background: BrowserPageBackground): void;
}): ReactNode {
	const [widthText, setWidthText] = useState(width === null ? "" : String(width));
	const [heightText, setHeightText] = useState(height === null ? "" : String(height));
	useEffect(() => setWidthText(width === null ? "" : String(width)), [width]);
	useEffect(() => setHeightText(height === null ? "" : String(height)), [height]);
	const commitSize = (): void => {
		if (width === null || height === null) return;
		const next = clampViewportSize(Number(widthText) || width, Number(heightText) || height);
		setWidthText(String(next.width));
		setHeightText(String(next.height));
		onSizeChange(next);
	};
	return (
		<div className="gui-browser-device-toolbar" aria-label={t("tools.browserDeviceToolbar")}>
			<label className="gui-browser-device-preset">
				<span>{t("tools.browserViewportPresets")}</span>
				<select value={preset} onChange={event => onPresetChange(event.target.value as BrowserViewportPreset)}>
					{BROWSER_VIEWPORTS.map(viewport => (
						<option key={viewport.key} value={viewport.key}>
							{t(viewport.key)}
						</option>
					))}
				</select>
			</label>
			<div
				className="gui-browser-device-dimensions"
				onBlur={event => {
					if (!event.currentTarget.contains(event.relatedTarget as Node | null)) commitSize();
				}}
			>
				<input
					type="number"
					aria-label={t("tools.browserViewportWidth")}
					min={320}
					max={7680}
					disabled={width === null}
					value={widthText}
					onChange={event => setWidthText(event.target.value)}
					onKeyDown={event => {
						if (event.key === "Enter") {
							event.preventDefault();
							commitSize();
						}
					}}
				/>
				<span aria-hidden>×</span>
				<input
					type="number"
					aria-label={t("tools.browserViewportHeight")}
					min={480}
					max={4320}
					disabled={height === null}
					value={heightText}
					onChange={event => setHeightText(event.target.value)}
					onKeyDown={event => {
						if (event.key === "Enter") {
							event.preventDefault();
							commitSize();
						}
					}}
				/>
			</div>
			<label>
				<span>{t("tools.browserDisplayScale")}</span>
				<select
					value={String(displayScale)}
					onChange={event =>
						onDisplayScaleChange(event.target.value === "fit" ? "fit" : Number(event.target.value))
					}
				>
					<option value="fit">{t("tools.browserFitToWindow")}</option>
					{SCALES.map(scale => (
						<option key={scale} value={scale}>
							{Math.round(scale * 100)}%
						</option>
					))}
				</select>
			</label>
			<label>
				<span>{t("tools.browserBackground")}</span>
				<select
					value={background}
					onChange={event => onBackgroundChange(event.target.value as BrowserPageBackground)}
				>
					<option value="auto">{t("tools.browserBackgroundAuto")}</option>
					<option value="light">{t("tools.browserBackgroundLight")}</option>
					<option value="dark">{t("tools.browserBackgroundDark")}</option>
				</select>
			</label>
		</div>
	);
}
