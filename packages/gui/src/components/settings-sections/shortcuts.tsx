import { t } from "@musepi/desktop-web";
import type { ReactNode } from "react";
import { shortcutLabel } from "../../lib/shortcuts";

export function ShortcutsSection(): ReactNode {
	const rows: { keys: string; action: string }[] = [
		{ keys: "⌘N", action: t("new task shortcut") },
		{ keys: "⌘K", action: t("search shortcut") },
		{ keys: "⌘,", action: t("settings shortcut") },
		{ keys: "⌘E", action: t("toggle panel shortcut") },
		{ keys: "⌘⇧E", action: t("focus mode shortcut") },
		{ keys: "⌘B", action: t("toggle sidebar shortcut") },
		{ keys: "⌘J", action: t("toggle terminal shortcut") },
		{ keys: "⌘O", action: t("open folder shortcut") },
		{ keys: "⌘L", action: t("quote selection shortcut") },
		{ keys: "⌘⇧L", action: t("ask selection shortcut") },
		{ keys: "⌘↩", action: t("send message shortcut") },
		{ keys: "⌘↓", action: t("scroll transcript shortcut") },
		{ keys: "⎋", action: t("stop agent shortcut") },
	];
	return (
		<>
			<h2 className="gui-settings-page-title">{t("shortcuts")}</h2>
			<p className="gui-settings-page-desc">{t("shortcuts settings")}</p>
			<div className="gui-kbd-table">
				<div className="gui-kbd-row gui-kbd-row--head">
					<span>{t("shortcut")}</span>
					<span>{t("action")}</span>
				</div>
				{rows.map(row => (
					<div key={row.keys} className="gui-kbd-row">
						<kbd className="gui-kbd">{shortcutLabel(row.keys)}</kbd>
						<span>{row.action}</span>
					</div>
				))}
			</div>
		</>
	);
}
