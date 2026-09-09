import type { DiffLayout } from "./parts";

/** Chat-settings pref (Settings → 聊天 → 差异布局), default inline. */
export function diffLayoutPref(): DiffLayout {
	try {
		const v = localStorage.getItem("musepi-gui-chat-difflayout");
		return v === "dynamic" || v === "side-by-side" ? v : "inline";
	} catch {
		return "inline";
	}
}
