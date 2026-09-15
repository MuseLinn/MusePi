/**
 * Empty-state navigation page for the tab-primary right panel (Kimi Work
 * "从这里开始" parity): what the panel shows when zero tabs are open. Entries
 * mirror the rail's launcher role — picking one opens the surface's tab.
 *
 * Presentational only: labels/icons/handlers come from the caller so the
 * component stays free of i18n and surface-registry imports.
 */
import type { ReactNode } from "react";

export interface PanelEmptyStateItem {
	readonly id: string;
	label: string;
	hint?: string;
	icon?: ReactNode;
	onSelect(): void;
}

export function PanelTabsEmptyState({
	heading,
	items,
}: {
	heading?: string;
	items: readonly PanelEmptyStateItem[];
}): ReactNode {
	return (
		<div className="gui-panel-empty" role="navigation" aria-label={heading}>
			{heading ? <p className="gui-panel-empty-heading">{heading}</p> : null}
			<ul className="gui-panel-empty-list">
				{items.map(item => (
					<li key={item.id}>
						<button type="button" className="gui-panel-empty-item" onClick={item.onSelect}>
							{item.icon ? <span className="gui-panel-empty-icon">{item.icon}</span> : null}
							<span className="gui-panel-empty-text">
								<span className="gui-panel-empty-label">{item.label}</span>
								{item.hint ? <span className="gui-panel-empty-hint">{item.hint}</span> : null}
							</span>
						</button>
					</li>
				))}
			</ul>
		</div>
	);
}
