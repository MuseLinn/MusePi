import { t } from "@musepi/client-core";
import { type ReactNode, useState, useSyncExternalStore } from "react";
import {
	type CapabilityTab,
	emitCapabilityNavAction,
	readCapabilityNav,
	subscribeCapabilityNav,
} from "../lib/capability-nav";
import { Icon, type IconName } from "../vendor/oc-icons";

/**
 * Capability-center SECOND-TIER PANEL — the same rail sidebar slot the home
 * session list and the task center's task panel use. It replaces the three
 * in-page tab buttons that used to sit in `WorkspacePageHeader.tabs`: a
 * destination owns one navigation column, and the content column renders
 * only the selected pane.
 *
 * Markup follows `gui-side-panel.css`: one full-width primary action, one
 * compact search row, flat named sections, full-width hover rows with a
 * single accent for selection, and a one-line empty hint. No destination
 * heading (the content header already owns it), no nested card faces.
 *
 * Data comes from the page through `lib/capability-nav` — one `page.tab`
 * source, one selected row. This component sends actions; the page owns the
 * tab state and every RPC. The Cordis contribution is
 * `sidebar.panel.capability` (`src/plugins/capability-panel/`); direct mounts
 * and contract tests may pass `width`/`collapsed` explicitly, but a slot
 * mount inherits `--gui-side-w` from the keeper.
 */

interface CapabilityEntry {
	id: CapabilityTab;
	label: string;
	icon: IconName;
	/** Installed/plugin count badge; the marketplace has no count. */
	count: number | null;
}

export function CapabilitySidePanel({
	width,
	collapsed,
}: {
	/** Optional geometry override; plugin mounts inherit the CSS variable. */
	width?: number;
	collapsed?: boolean;
}): ReactNode {
	const nav = useSyncExternalStore(subscribeCapabilityNav, readCapabilityNav, readCapabilityNav);
	const [query, setQuery] = useState("");

	const entries: CapabilityEntry[] = [
		{ id: "skills", label: t("tools.skillsTab"), icon: "sparkling", count: nav.skillsCount },
		{ id: "plugins", label: t("settings.plugins"), icon: "plug", count: nav.pluginsCount },
		{ id: "marketplace", label: t("guest.marketplace"), icon: "plug-2", count: null },
	];

	const q = query.trim().toLowerCase();
	const visible = q ? entries.filter(entry => entry.label.toLowerCase().includes(q)) : entries;

	return (
		<aside
			className={`gui-pane-side gui-pane-side--immersive gui-capability-slot gui-side-panel flex h-full flex-shrink-0 flex-col overflow-hidden${collapsed ? " gui-pane-side--collapsed" : ""}`}
			style={width === undefined ? undefined : { width: collapsed ? 0 : width }}
			aria-label={t("tools.capabilityCenter")}
		>
			<div className="gui-pane-drag flex h-9 flex-shrink-0 items-center justify-end pr-2" />
			<div className="gui-side-panel-head">
				{/* No panel heading: the destination title already lives in the
				 * content header. The primary action is a real entry point into
				 * the marketplace, not a second copy of the tab row. */}
				<button
					type="button"
					className="gui-side-panel-primary"
					onClick={() => emitCapabilityNavAction({ type: "add" })}
				>
					<Icon name="add" className="h-3.5 w-3.5" />
					<span>{t("tools.capabilityPanelAdd")}</span>
				</button>
				<div className="gui-side-panel-tools">
					<label className="gui-side-panel-search">
						<Icon name="search" className="h-3.5 w-3.5 shrink-0" />
						<input
							value={query}
							onChange={event => setQuery(event.target.value)}
							placeholder={t("settings.search")}
							aria-label={t("tools.capabilityPanelSearch")}
						/>
					</label>
				</div>
			</div>
			<div className="gui-side-panel-scroll">
				{visible.length === 0 ? (
					<div className="gui-side-panel-empty">
						<div className="gui-side-panel-empty-title">{t("tools.capabilityPanelNoMatches")}</div>
					</div>
				) : (
					<div className="gui-side-panel-section" role="tablist">
						<div className="gui-side-panel-section-title">
							<Icon name="star" className="h-3.5 w-3.5 shrink-0" />
							<span>{t("tools.capabilityPanelBrowse")}</span>
							<span className="gui-side-panel-count">{visible.length}</span>
						</div>
						{visible.map(entry => (
							<button
								key={entry.id}
								type="button"
								role="tab"
								data-capability-tab={entry.id}
								aria-selected={nav.tab === entry.id}
								className={`gui-side-panel-row${nav.tab === entry.id ? " gui-side-panel-row--active" : ""}`}
								onClick={() => emitCapabilityNavAction({ type: "select", tab: entry.id })}
							>
								<Icon name={entry.icon} className="gui-side-panel-row-meta h-3.5 w-3.5 shrink-0" />
								<span className="gui-side-panel-row-label">{entry.label}</span>
								{entry.count !== null && <span className="gui-side-panel-count">{entry.count}</span>}
							</button>
						))}
					</div>
				)}
			</div>
		</aside>
	);
}
