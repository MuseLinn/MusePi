import { t } from "@musepi/client-core";
import { Maximize2, Monitor, SlidersHorizontal, Smartphone, Tablet } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import "../styles/gui-browser-toolbar.css";
import type { BrowserDisplayScale } from "../lib/browser-viewport";
import { clampViewportSize } from "../lib/browser-viewport";
import { useFloatingMenu } from "../lib/use-floating-menu";
import { GuiSelect } from "./GuiSelect";

export const BROWSER_VIEWPORTS = [
	{ key: "tools.browserViewportFit", width: null, height: null, device: "fit" },
	// Legacy persisted presets stay selectable after the catalog expansion.
	{ key: "tools.browserViewportPhone", width: 393, height: 852, device: "phone" },
	{ key: "tools.browserViewportTablet", width: 768, height: 1024, device: "tablet" },
	{ key: "tools.browserViewportDesktop", width: 1440, height: 900, device: "desktop" },
	{ key: "tools.browserViewportIphoneSe", width: 375, height: 667, device: "phone" },
	{ key: "tools.browserViewportIphone12Pro", width: 390, height: 844, device: "phone" },
	{ key: "tools.browserViewportIphone14Pro", width: 393, height: 852, device: "phone" },
	{ key: "tools.browserViewportIphone14ProMax", width: 430, height: 932, device: "phone" },
	{ key: "tools.browserViewportIphone16Pro", width: 402, height: 874, device: "phone" },
	{ key: "tools.browserViewportIphone16ProMax", width: 440, height: 956, device: "phone" },
	{ key: "tools.browserViewportPixel7", width: 412, height: 915, device: "phone" },
	{ key: "tools.browserViewportPixel8", width: 412, height: 915, device: "phone" },
	{ key: "tools.browserViewportPixel9", width: 412, height: 924, device: "phone" },
	{ key: "tools.browserViewportGalaxyS20Ultra", width: 412, height: 915, device: "phone" },
	{ key: "tools.browserViewportIphoneDuoOuter", width: 466, height: 678, device: "phone" },
	{ key: "tools.browserViewportIphoneDuoInner", width: 669, height: 951, device: "tablet" },
	{ key: "tools.browserViewportIpadMini", width: 768, height: 1024, device: "tablet" },
	{ key: "tools.browserViewportIpadPro13", width: 1032, height: 1376, device: "tablet" },
	{ key: "tools.browserViewportDesktop1280", width: 1280, height: 800, device: "desktop" },
	{ key: "tools.browserViewportDesktop1440", width: 1440, height: 900, device: "desktop" },
	{ key: "tools.browserViewportDesktop1920", width: 1920, height: 1080, device: "desktop" },
] as const;

export type BrowserViewportPreset = (typeof BROWSER_VIEWPORTS)[number]["key"];
export type BrowserPageBackground = "auto" | "light" | "dark";

const SCALES = [0.25, 0.4, 0.5, 0.67, 0.75, 0.9, 1, 1.25, 1.5, 2] as const;

function presetIcon(device: "fit" | "phone" | "tablet" | "desktop") {
	return device === "phone" ? Smartphone : device === "tablet" ? Tablet : device === "desktop" ? Monitor : Maximize2;
}

const BACKGROUNDS = ["auto", "light", "dark"] as const;

const BACKGROUND_LABEL_KEYS = {
	auto: "tools.browserBackgroundAuto",
	light: "tools.browserBackgroundLight",
	dark: "tools.browserBackgroundDark",
} as const;

const HIDDEN_KEY = "musepi-gui-browser-device-toolbar";

export function readBrowserDeviceToolbarVisibility(): boolean {
	try {
		return window.localStorage.getItem(HIDDEN_KEY) !== "hidden";
	} catch {
		return true;
	}
}

export function setBrowserDeviceToolbarVisibility(visible: boolean): void {
	try {
		if (visible) window.localStorage.removeItem(HIDDEN_KEY);
		else window.localStorage.setItem(HIDDEN_KEY, "hidden");
	} catch {
		// Storage unavailable — the current window still follows React state.
	}
}

/** Compact device strip: one row of labelled selectors. Hidden means not
 *  rendered at all; the browser menu is the single visibility control. */
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
	disabled,
	visible = true,
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
	/** Disable page-emulation controls while preserving the current values. */
	disabled?: boolean;
	visible?: boolean;
}): ReactNode {
	const [widthText, setWidthText] = useState(width === null ? "" : String(width));
	const [heightText, setHeightText] = useState(height === null ? "" : String(height));
	const [resizeOpen, setResizeOpen] = useState(false);
	const resizeAnchorRef = useRef<HTMLButtonElement | null>(null);
	const resizeMenu = useFloatingMenu(resizeOpen, setResizeOpen, {
		className: "gui-browser-size-menu",
		anchor: resizeAnchorRef.current,
		align: "left",
	});
	useEffect(() => setWidthText(width === null ? "" : String(width)), [width]);
	useEffect(() => setHeightText(height === null ? "" : String(height)), [height]);

	if (!visible) return null;

	const commitSize = (): void => {
		if (disabled || width === null || height === null) return;
		const next = clampViewportSize(Number(widthText) || width, Number(heightText) || height);
		setWidthText(String(next.width));
		setHeightText(String(next.height));
		onSizeChange(next);
	};

	const presetOptions = BROWSER_VIEWPORTS.map(viewport => {
		const DeviceIcon = presetIcon(viewport.device);
		return {
			value: viewport.key,
			label: t(viewport.key),
			leading: <DeviceIcon size={13} aria-hidden />,
		};
	});
	const activePreset = BROWSER_VIEWPORTS.find(viewport => viewport.key === preset) ?? BROWSER_VIEWPORTS[0];
	const ActiveDeviceIcon = presetIcon(activePreset.device);
	const backgroundOptions = BACKGROUNDS.map(value => ({
		value,
		label: t(BACKGROUND_LABEL_KEYS[value]),
		leading: <span className={`gui-browser-bg-dot gui-browser-bg-dot--${value}`} aria-hidden />,
	}));
	const scaleOptions = [
		{ value: "fit", label: t("tools.browserFitToWindow") },
		...SCALES.map(scale => ({ value: String(scale), label: `${Math.round(scale * 100)}%` })),
	];
	const resizeTo = (nextWidth: number, nextHeight: number): void => {
		if (disabled) return;
		const next = clampViewportSize(nextWidth, nextHeight);
		setWidthText(String(next.width));
		setHeightText(String(next.height));
		onSizeChange(next);
	};

	return (
		<div className="gui-browser-toolbar" role="group" aria-label={t("tools.browserDeviceToolbar")}>
			<span className="gui-browser-toolbar-label">{t("tools.browserViewportSizeLabel")}</span>
			<GuiSelect
				className="gui-browser-toolbar-preset"
				value={preset}
				options={presetOptions}
				onChange={onPresetChange}
				ariaLabel={t("tools.browserViewportPresets")}
				disabled={disabled}
			/>
			{width === null ? null : (
				<div
					className="gui-browser-toolbar-size"
					onBlur={event => {
						if (!event.currentTarget.contains(event.relatedTarget as Node | null)) commitSize();
					}}
				>
					<input
						className="gui-browser-toolbar-input"
						type="text"
						inputMode="numeric"
						aria-label={t("tools.browserViewportWidth")}
						value={widthText}
						disabled={disabled}
						onChange={event => setWidthText(event.target.value)}
						onKeyDown={event => {
							if (event.key === "Enter") {
								event.preventDefault();
								commitSize();
							}
						}}
					/>
					<span className="gui-browser-toolbar-size-x" aria-hidden>
						×
					</span>
					<input
						className="gui-browser-toolbar-input"
						type="text"
						inputMode="numeric"
						aria-label={t("tools.browserViewportHeight")}
						value={heightText}
						disabled={disabled}
						onChange={event => setHeightText(event.target.value)}
						onKeyDown={event => {
							if (event.key === "Enter") {
								event.preventDefault();
								commitSize();
							}
						}}
					/>
				</div>
			)}
			{width === null || height === null ? null : (
				<>
					<button
						ref={resizeAnchorRef}
						type="button"
						className="gui-browser-toolbar-resize"
						aria-label={t("tools.browserResizeSize")}
						title={t("tools.browserResizeSize")}
						aria-expanded={resizeOpen}
						disabled={disabled}
						onClick={() => setResizeOpen(open => !open)}
					>
						<SlidersHorizontal size={13} aria-hidden />
					</button>
					{resizeMenu.renderMenu(
						<div className="gui-browser-size-controls" role="group" aria-label={t("tools.browserResizeSize")}>
							<label>
								<span>{t("tools.browserViewportWidth")}</span>
								<output>{t("tools.browserPixels", { value: Math.round(width) })}</output>
							</label>
							<input
								type="range"
								min={320}
								max={1600}
								step={1}
								value={Math.round(width)}
								disabled={disabled}
								aria-label={t("tools.browserViewportWidth")}
								onInput={event => resizeTo(Number((event.target as HTMLInputElement).value), height)}
							/>
							<label>
								<span>{t("tools.browserViewportHeight")}</span>
								<output>{t("tools.browserPixels", { value: Math.round(height) })}</output>
							</label>
							<input
								type="range"
								min={480}
								max={1800}
								step={1}
								value={Math.round(height)}
								disabled={disabled}
								aria-label={t("tools.browserViewportHeight")}
								onInput={event => resizeTo(width, Number((event.target as HTMLInputElement).value))}
							/>
						</div>,
					)}
				</>
			)}
			<GuiSelect
				className="gui-browser-toolbar-background"
				value={background}
				options={backgroundOptions}
				onChange={onBackgroundChange}
				ariaLabel={t("tools.browserBackground")}
				disabled={disabled}
			/>
			<GuiSelect
				className="gui-browser-toolbar-scale"
				value={displayScale === "fit" ? "fit" : String(displayScale)}
				onChange={next => onDisplayScaleChange(next === "fit" ? "fit" : Number(next))}
				options={scaleOptions}
				ariaLabel={t("tools.browserDisplayScale")}
				disabled={disabled}
			/>
			<span className="gui-browser-toolbar-device" title={t(activePreset.key)} aria-hidden>
				<ActiveDeviceIcon size={13} />
			</span>
		</div>
	);
}
