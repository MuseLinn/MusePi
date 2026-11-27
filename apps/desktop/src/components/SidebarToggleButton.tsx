import { t } from "@musepi/client-core";
import { PanelLeftClose as PanelLeftCloseIconData, PanelLeftOpen as PanelLeftOpenIconData } from "lucide";
import { MorphIcon } from "morphicons/react";
import type { ReactNode } from "react";

export function SidebarToggleButton({
	collapsed,
	onToggle,
}: {
	collapsed: boolean;
	onToggle(anchor: HTMLButtonElement): void;
}): ReactNode {
	const label = collapsed ? t("transcript.openSidebar") : t("transcript.closeSidebar");
	return (
		<button
			type="button"
			className="gui-sidebar-toggle"
			data-collapsed={collapsed ? "true" : "false"}
			title={label}
			aria-label={label}
			aria-expanded={!collapsed}
			aria-controls="gui-sidebar-list-region"
			onClick={event => onToggle(event.currentTarget)}
		>
			<MorphIcon
				icon={collapsed ? PanelLeftOpenIconData : PanelLeftCloseIconData}
				size={16}
				spring="snappy"
				reducedMotion="user"
				className="h-4 w-4"
			/>
		</button>
	);
}
