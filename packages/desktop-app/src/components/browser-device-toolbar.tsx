import { Segmented, t } from "@musepi/client-core";
import { ChevronDown as ChevronDownIconData, ChevronUp as ChevronUpIconData } from "lucide";
import { Maximize2, Monitor, Smartphone, Tablet } from "lucide-react";
import { MorphIcon } from "morphicons/react";
import type { KeyboardEvent, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import "../styles/gui-browser-toolbar.css";
import type { BrowserDisplayScale } from "../lib/browser-viewport";
import { clampViewportSize } from "../lib/browser-viewport";
import { Icon } from "../vendor/oc-icons";
import { GuiSelect } from "./GuiSelect";

export const BROWSER_VIEWPORTS = [
	{ key: "tools.browserViewportFit", width: null, height: null, device: "fit" },
	{ key: "tools.browserViewportPhone", width: 393, height: 852, device: "phone" },
	{ key: "tools.browserViewportTablet", width: 768, height: 1024, device: "tablet" },
	{ key: "tools.browserViewportDesktop", width: 1440, height: 900, device: "desktop" },
] as const;

export type BrowserViewportPreset = (typeof BROWSER_VIEWPORTS)[number]["key"];
export type BrowserPageBackground = "auto" | "light" | "dark";

const SCALES = [0.25, 0.4, 0.5, 0.67, 0.75, 0.9, 1, 1.25, 1.5, 2] as const;

const PRESET_ICONS = {
	"tools.browserViewportFit": Maximize2,
	"tools.browserViewportPhone": Smartphone,
	"tools.browserViewportTablet": Tablet,
	"tools.browserViewportDesktop": Monitor,
} as const;

const BACKGROUNDS = ["auto", "light", "dark"] as const;

const BACKGROUND_LABEL_KEYS = {
	auto: "tools.browserBackgroundAuto",
	light: "tools.browserBackgroundLight",
	dark: "tools.browserBackgroundDark",
} as const;

/** Collapse choice, per window: a device bar that keeps reappearing after the
 *  user folded it away is the reason the fold exists in the first place. */
const HIDDEN_KEY = "musepi-gui-browser-device-toolbar";

function readHidden(): boolean {
	try {
		return window.localStorage.getItem(HIDDEN_KEY) === "hidden";
	} catch {
		return false;
	}
}

function writeHidden(hidden: boolean): void {
	try {
		if (hidden) window.localStorage.setItem(HIDDEN_KEY, "hidden");
		else window.localStorage.removeItem(HIDDEN_KEY);
	} catch {
		// Storage unavailable — the choice just doesn't survive the window.
	}
}

/** Device-emulation strip: preset / emulated size / display scale / page
 *  background, collapsible to a one-line reveal pill (Kimi Code "hide device
 *  toolbar" parity). Everything routes through the shared controls
 *  (Segmented / GuiSelect / framed inputs / swatches), so the bar reads as
 *  MusePi chrome rather than a browser-default form. */
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
	const [hidden, setHidden] = useState(readHidden);
	const backgroundRefs = useRef<Array<HTMLButtonElement | null>>([]);
	useEffect(() => setWidthText(width === null ? "" : String(width)), [width]);
	useEffect(() => setHeightText(height === null ? "" : String(height)), [height]);

	const commitSize = (): void => {
		if (width === null || height === null) return;
		const next = clampViewportSize(Number(widthText) || width, Number(heightText) || height);
		setWidthText(String(next.width));
		setHeightText(String(next.height));
		onSizeChange(next);
	};

	const toggleHidden = (next: boolean): void => {
		setHidden(next);
		writeHidden(next);
	};

	const presetOptions = BROWSER_VIEWPORTS.map(viewport => ({
		value: viewport.key,
		label: t(viewport.key),
		icon: PRESET_ICONS[viewport.key],
	}));
	const scaleOptions = [
		{ value: "fit", label: t("tools.browserFitToWindow") },
		...SCALES.map(scale => ({ value: String(scale), label: `${Math.round(scale * 100)}%` })),
	];
	const activeIndex = Math.max(0, BACKGROUNDS.indexOf(background));
	const moveBackground = (next: number): void => {
		const value = BACKGROUNDS[next];
		if (!value) return;
		onBackgroundChange(value);
		backgroundRefs.current[next]?.focus();
	};
	const onBackgroundKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
		if (event.key === "ArrowRight" || event.key === "ArrowDown") {
			event.preventDefault();
			moveBackground((activeIndex + 1) % BACKGROUNDS.length);
		} else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
			event.preventDefault();
			moveBackground((activeIndex - 1 + BACKGROUNDS.length) % BACKGROUNDS.length);
		} else if (event.key === "Home" || event.key === "End") {
			event.preventDefault();
			moveBackground(event.key === "Home" ? 0 : BACKGROUNDS.length - 1);
		}
	};
	const ActiveDeviceIcon = PRESET_ICONS[preset];

	return (
		<div
			className={`gui-browser-toolbar${hidden ? " gui-browser-toolbar--collapsed" : ""}`}
			role="group"
			aria-label={t("tools.browserDeviceToolbar")}
		>
			{hidden ? null : (
				<div className="gui-browser-toolbar-body">
					<Segmented
						className="gui-browser-toolbar-presets"
						value={preset}
						options={presetOptions}
						onChange={onPresetChange}
						ariaLabel={t("tools.browserViewportPresets")}
						iconOnly
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
					<GuiSelect
						className="gui-browser-toolbar-scale"
						value={displayScale === "fit" ? "fit" : String(displayScale)}
						onChange={next => onDisplayScaleChange(next === "fit" ? "fit" : Number(next))}
						options={scaleOptions}
						ariaLabel={t("tools.browserDisplayScale")}
					/>
					<div
						className="gui-browser-toolbar-bg"
						role="radiogroup"
						aria-label={t("tools.browserBackground")}
						onKeyDown={onBackgroundKeyDown}
					>
						{BACKGROUNDS.map((value, index) => (
							<button
								key={value}
								ref={element => {
									backgroundRefs.current[index] = element;
								}}
								type="button"
								role="radio"
								aria-checked={background === value}
								aria-label={t(BACKGROUND_LABEL_KEYS[value])}
								title={t(BACKGROUND_LABEL_KEYS[value])}
								tabIndex={background === value ? 0 : -1}
								className={`gui-browser-toolbar-swatch gui-browser-toolbar-swatch--${value}`}
								onClick={() => onBackgroundChange(value)}
							>
								{background === value ? (
									<Icon name="check" className="gui-browser-toolbar-swatch-check" />
								) : null}
							</button>
						))}
					</div>
				</div>
			)}
			<button
				type="button"
				className={`gui-browser-toolbar-toggle${hidden ? " gui-browser-toolbar-toggle--collapsed" : ""}`}
				aria-expanded={!hidden}
				aria-label={hidden ? `${t("tools.browserDeviceToolbar")} · ${t(preset)}` : t("tools.browserDeviceToolbar")}
				title={t("tools.browserDeviceToolbar")}
				onClick={() => toggleHidden(!hidden)}
			>
				{hidden ? (
					<>
						<ActiveDeviceIcon className="gui-browser-toolbar-toggle-device" size={14} aria-hidden />
						<span className="gui-browser-toolbar-toggle-label">{t(preset)}</span>
					</>
				) : null}
				<MorphIcon icon={hidden ? ChevronDownIconData : ChevronUpIconData} size={14} spring="snappy" />
			</button>
		</div>
	);
}
