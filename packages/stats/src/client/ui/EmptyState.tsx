import { Inbox, type LucideIcon } from "lucide-react";
import { t } from "../i18n";

export interface EmptyStateProps {
	message?: string;
	icon?: LucideIcon;
	className?: string;
}

export function EmptyState({ message = "No data available", icon: Icon = Inbox, className = "" }: EmptyStateProps) {
	return (
		<div className={`stats-empty-state ${className}`}>
			<Icon size={24} className="stats-empty-state-icon" aria-hidden="true" />
			<p className="stats-empty-state-message">{t(message)}</p>
		</div>
	);
}
