import { t } from "@musepi/client-core";
import type { ReactNode } from "react";
import { Icon, type IconName } from "../vendor/oc-icons";

export function WorkspacePageHeader({
	icon,
	title,
	description,
	onBack,
	backLabel,
	meta,
	actions,
	tabs,
}: {
	icon: IconName;
	title: ReactNode;
	description?: ReactNode;
	onBack?(): void;
	backLabel?: string;
	meta?: ReactNode;
	actions?: ReactNode;
	tabs?: ReactNode;
}): ReactNode {
	return (
		<header className="gui-workspace-header">
			<div className="gui-workspace-header-main">
				{onBack && (
					<button
						type="button"
						className="gui-tool-btn gui-workspace-header-back"
						onClick={onBack}
						aria-label={backLabel ?? t("settings.back")}
						title={backLabel ?? t("settings.back")}
					>
						<Icon name="arrow-left" className="h-4 w-4" />
					</button>
				)}
				<div className="gui-workspace-header-copy">
					<div className="gui-workspace-header-title-row">
						<Icon name={icon} className="gui-workspace-header-icon h-4 w-4" />
						<h1 className="gui-workspace-header-title">{title}</h1>
						{meta && <div className="gui-workspace-header-meta">{meta}</div>}
					</div>
					{description && <div className="gui-workspace-header-description">{description}</div>}
				</div>
				{actions && <div className="gui-workspace-header-actions">{actions}</div>}
			</div>
			{tabs && <div className="gui-workspace-header-tabs">{tabs}</div>}
		</header>
	);
}
