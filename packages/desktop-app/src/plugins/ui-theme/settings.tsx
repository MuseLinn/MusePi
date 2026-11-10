import { t } from "@musepi/client-core";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { GuiSelect } from "../../components/GuiSelect";
import {
	getScrollbarSkins,
	readAlwaysShowScrollbar,
	readScrollbarStyle,
	SCROLLBAR_ALWAYS_CHANGED_EVENT,
	SCROLLBAR_SKINS_CHANGED_EVENT,
	SCROLLBAR_STYLE_CHANGED_EVENT,
	SCROLLBAR_STYLE_KEY,
	type ScrollbarSkin,
	saveAlwaysShowScrollbar,
	saveImportedSkin,
	validateImportedSkin,
} from "./skins";

function setPref(key: string, value: string): void {
	try {
		localStorage.setItem(key, value);
	} catch {
		// storage unavailable — the session keeps the in-memory choice
	}
}

/**
 * `settings.item.ui-theme`: the rail's appearance card.
 *
 * The card lives in the extension center (this platform's home for
 * plugin-owned settings) and owns the skin picker, zip import and the
 * always-visible switch. State is localStorage + the same window events the
 * rail listens to, so a change applies on the next frame without a restart.
 * The built-in catalog comes from the bundle's `skins.ts`; third-party skins
 * arrive through `extensions.list.scrollbarSkins` into the shared registry.
 */
export default function UiThemeSettings(): ReactNode {
	const [skinId, setSkinId] = useState<string>(() => readScrollbarStyle());
	const [skins, setSkins] = useState<ScrollbarSkin[]>(() => getScrollbarSkins());
	const [always, setAlways] = useState<boolean>(() => readAlwaysShowScrollbar());
	const [importing, setImporting] = useState(false);
	const [error, setError] = useState(false);

	useEffect(() => {
		const syncSkins = (): void => {
			setSkins(getScrollbarSkins());
			setSkinId(readScrollbarStyle());
		};
		const syncAlways = (): void => setAlways(readAlwaysShowScrollbar());
		window.addEventListener(SCROLLBAR_SKINS_CHANGED_EVENT, syncSkins);
		window.addEventListener(SCROLLBAR_STYLE_CHANGED_EVENT, syncSkins);
		window.addEventListener(SCROLLBAR_ALWAYS_CHANGED_EVENT, syncAlways);
		return () => {
			window.removeEventListener(SCROLLBAR_SKINS_CHANGED_EVENT, syncSkins);
			window.removeEventListener(SCROLLBAR_STYLE_CHANGED_EVENT, syncSkins);
			window.removeEventListener(SCROLLBAR_ALWAYS_CHANGED_EVENT, syncAlways);
		};
	}, []);

	const bridge = (window as unknown as { electronAPI?: { importScrollbarSkin?(): Promise<unknown> } }).electronAPI;

	return (
		<div className="gui-settings-section">
			<div className="gui-settings-section-title">{t("settings.scrollbarStyle")}</div>
			<div className="gui-settings-section-desc">{t("settings.scrollbarStyleHint")}</div>
			<div className="gui-settings-field-control">
				<GuiSelect
					className="gui-settings-select"
					value={skinId}
					onChange={next => {
						setSkinId(next);
						setPref(SCROLLBAR_STYLE_KEY, next);
						window.dispatchEvent(new Event(SCROLLBAR_STYLE_CHANGED_EVENT));
					}}
					options={skins.map(skin => ({
						value: skin.id,
						label:
							skin.id === "builtin-snake"
								? t("settings.snake")
								: skin.id === "builtin-gummy-rainbow"
									? t("settings.gummyRainbow")
									: skin.id === "builtin-pacman"
										? t("settings.pacman")
										: skin.displayName,
					}))}
				/>
				{bridge?.importScrollbarSkin ? (
					<div className="flex items-center gap-2">
						<button
							type="button"
							className="gui-btn"
							disabled={importing}
							onClick={() => {
								setImporting(true);
								setError(false);
								void bridge
									.importScrollbarSkin?.()
									.then(raw => {
										if (!raw) return; // cancelled
										const skin = validateImportedSkin(raw);
										if (!skin) {
											setError(true);
											return;
										}
										saveImportedSkin(skin);
										setSkins(getScrollbarSkins());
										setSkinId(skin.id);
										setPref(SCROLLBAR_STYLE_KEY, skin.id);
										window.dispatchEvent(new Event(SCROLLBAR_STYLE_CHANGED_EVENT));
									})
									.catch(() => setError(true))
									.finally(() => setImporting(false));
							}}
						>
							{importing ? "…" : t("settings.importScrollbarSkin")}
						</button>
						{error && (
							<span className="text-xs" style={{ color: "var(--color-danger, #ff5c5c)" }}>
								{t("settings.invalidScrollbarSkin")}
							</span>
						)}
					</div>
				) : null}
			</div>
			<div className="gui-settings-row">
				<div className="flex-1">
					<div className="gui-settings-row-label">{t("settings.alwaysShowScrollbars")}</div>
					<div className="gui-settings-row-desc">{t("settings.alwaysShowScrollbarsDesc")}</div>
				</div>
				<button
					type="button"
					role="switch"
					aria-checked={always}
					className={`gui-toggle${always ? " gui-toggle--on" : ""}`}
					aria-label={t("settings.alwaysShowScrollbars")}
					onClick={() => {
						const next = !always;
						setAlways(next);
						saveAlwaysShowScrollbar(next);
					}}
				>
					<span className="gui-toggle-knob" />
				</button>
			</div>
		</div>
	);
}
