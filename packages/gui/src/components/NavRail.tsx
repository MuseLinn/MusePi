import { type TranslationKey, t } from "@musepi/collab-web";
import type { ReactNode } from "react";
import { Icon } from "../vendor/oc-icons";

export type NavView = "sessions" | "search" | "tasks" | "skills";

export interface NavItemDef {
	view: NavView;
	icon: "chat-1" | "search" | "checkbox-multiple" | "sparkling";
	label: TranslationKey;
}

export const NAV_ITEMS: NavItemDef[] = [
	{ view: "sessions", icon: "chat-1", label: "sessions" },
	{ view: "search", icon: "search", label: "search" },
	{ view: "tasks", icon: "checkbox-multiple", label: "tasks" },
	{ view: "skills", icon: "sparkling", label: "skills" },
];

/**
 * OpenChamber-style sidebar: a wide rail with icon buttons at the top
 * (sessions/search/tasks/skills), the active view's content below, and a
 * settings icon at the bottom. Icons come from the vendored openchamber
 * sprite (236 icons, currentColor, MIT).
 */
export function NavRail({
	active,
	onSelect,
	onSettings,
	children,
}: {
	active: NavView;
	onSelect(view: NavView): void;
	onSettings?(): void;
	children?: ReactNode;
}): ReactNode {
	return (
		<aside className="gui-navrail">
			<div className="gui-navrail-top">
				{NAV_ITEMS.map(item => (
					<button
						key={item.view}
						type="button"
						className={`gui-navitem${active === item.view ? " gui-navitem--active" : ""}`}
						title={t(item.label)}
						aria-label={t(item.label)}
						aria-current={active === item.view ? "page" : undefined}
						onClick={() => onSelect(item.view)}
					>
						<Icon name={item.icon} className="gui-navitem-icon" />
						<span className="gui-navitem-label">{t(item.label)}</span>
					</button>
				))}
			</div>
			<div className="gui-navrail-content">{children}</div>
			<div className="gui-navrail-bottom">
				<button
					type="button"
					className="gui-navitem"
					title={t("settings")}
					aria-label={t("settings")}
					onClick={() => onSettings?.()}
				>
					<Icon name="settings-3" className="gui-navitem-icon" />
					<span className="gui-navitem-label">{t("settings")}</span>
				</button>
			</div>
		</aside>
	);
}
