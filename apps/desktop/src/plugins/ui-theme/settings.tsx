import { t } from "@musepi/client-core";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { GuiSelect } from "../../components/GuiSelect";
import {
	applyScrollbarSkin,
	getScrollbarSkin,
	getScrollbarSkins,
	readScrollbarStyle,
	SCROLLBAR_SKINS_CHANGED_EVENT,
	SCROLLBAR_STYLE_CHANGED_EVENT,
	SCROLLBAR_STYLE_KEY,
	type ScrollbarSkin,
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

/** Pick the skin's label: the built-in ids are locale-owned, a contributed or
 *  imported skin supplies its own plain-text name. */
function skinLabel(skin: ScrollbarSkin): string {
	switch (skin.id) {
		case "classic":
			return t("settings.scrollbarClassic");
		case "builtin-snake":
			return t("settings.snake");
		case "builtin-gummy-rainbow":
			return t("settings.gummyRainbow");
		default:
			return skin.displayName;
	}
}

/**
 * `settings.item.appearance.rail`: the scrollbar appearance card.
 *
 * The bar is native, so the card owns only the skin pick and the zip import.
 * Choosing a skin writes localStorage, applies the palette/attribute to
 * `<html>` and notifies the window; nothing re-renders the scrollbar itself.
 */
export default function UiThemeSettings(): ReactNode {
	const [skinId, setSkinId] = useState<string>(() => getScrollbarSkin(readScrollbarStyle()).id);
	const [skins, setSkins] = useState<ScrollbarSkin[]>(() => getScrollbarSkins());
	const [importing, setImporting] = useState(false);
	const [error, setError] = useState(false);

	useEffect(() => {
		const sync = (): void => {
			setSkins(getScrollbarSkins());
			setSkinId(getScrollbarSkin(readScrollbarStyle()).id);
		};
		window.addEventListener(SCROLLBAR_SKINS_CHANGED_EVENT, sync);
		window.addEventListener(SCROLLBAR_STYLE_CHANGED_EVENT, sync);
		return () => {
			window.removeEventListener(SCROLLBAR_SKINS_CHANGED_EVENT, sync);
			window.removeEventListener(SCROLLBAR_STYLE_CHANGED_EVENT, sync);
		};
	}, []);

	const choose = (next: string): void => {
		setSkinId(next);
		setPref(SCROLLBAR_STYLE_KEY, next);
		applyScrollbarSkin(next);
		window.dispatchEvent(new Event(SCROLLBAR_STYLE_CHANGED_EVENT));
	};

	const bridge = (window as unknown as { electronAPI?: { importScrollbarSkin?(): Promise<unknown> } }).electronAPI;

	return (
		<div className="gui-settings-section">
			<div className="gui-settings-section-title">{t("settings.scrollbarStyle")}</div>
			<div className="gui-settings-section-desc">{t("settings.scrollbarStyleHint")}</div>
			<div className="gui-settings-field-control">
				<GuiSelect
					className="gui-settings-select"
					value={skinId}
					onChange={choose}
					options={skins.map(skin => ({ value: skin.id, label: skinLabel(skin) }))}
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
										choose(skin.id);
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
		</div>
	);
}
