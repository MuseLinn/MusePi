import { t } from "@musepi/client-core";
import { PanelLeftClose as PanelLeftCloseIconData, PanelLeftOpen as PanelLeftOpenIconData } from "lucide";
import { MorphIcon } from "morphicons/react";
import type { ReactNode } from "react";

export function SidebarToggleButton({
	collapsed,
	onToggle,
	onPeekOpen,
	onPeekClose,
}: {
	collapsed: boolean;
	onToggle(anchor: HTMLButtonElement): void;
	onPeekOpen?(anchor: HTMLButtonElement): void;
	onPeekClose?(): void;
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
			onPointerEnter={event => onPeekOpen?.(event.currentTarget)}
			onPointerLeave={() => onPeekClose?.()}
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
