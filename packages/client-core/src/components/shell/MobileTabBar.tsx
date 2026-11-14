import { Link2, MessageSquare, Settings } from "lucide-react";
import type { ReactNode } from "react";
import { t } from "../../i18n/index.js";
import { isHarmonyShell } from "../../lib/capacitor";

export type MobileTab = "connect" | "chat" | "settings";

/** Floating bottom navigation for the mobile shells (Capacitor / HarmonyOS
 * ArkWeb / mobile PWA). Pinned above the gesture bar with 48px tap targets.
 * It is a floating pill rather than a layout row so the transcript and the
 * composer keep their full height — the same geometry HarmonyOS HDS uses for
 * its floating bottom tabs (barOverlap + barFloatingStyle). */
export function MobileTabBar({
	active,
	chatAvailable,
	onChange,
}: {
	active: MobileTab;
	chatAvailable: boolean;
	onChange(tab: MobileTab): void;
}): ReactNode {
	const itemClass = (id: MobileTab): string => `sh-tabbar-item${active === id ? " sh-tabbar-item--active" : ""}`;

	// HarmonyOS draws the bar natively (ArkUI Tabs + the system immersive
	// light-sense material, see apps/harmony Index.ets). Painting a second,
	// web-styled bar there would double the navigation and swap a real system
	// material for a CSS imitation. Android / mobile PWA keep this one.
	if (isHarmonyShell()) return null;

	return (
		<nav className="sh-tabbar" aria-label={t("shell.tabNavigation")}>
			<button
				type="button"
				className={itemClass("connect")}
				aria-current={active === "connect" ? "page" : undefined}
				onClick={() => onChange("connect")}
			>
				<Link2 size={20} aria-hidden="true" />
				<span>{t("shell.tabConnect")}</span>
			</button>
			<button
				type="button"
				className={itemClass("chat")}
				aria-current={active === "chat" ? "page" : undefined}
				disabled={!chatAvailable}
				onClick={() => onChange("chat")}
			>
				<MessageSquare size={20} aria-hidden="true" />
				<span>{t("shell.tabChat")}</span>
			</button>
			<button
				type="button"
				className={itemClass("settings")}
				aria-current={active === "settings" ? "page" : undefined}
				onClick={() => onChange("settings")}
			>
				<Settings size={20} aria-hidden="true" />
				<span>{t("shell.tabSettings")}</span>
			</button>
		</nav>
	);
}
