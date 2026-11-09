import { t } from "@musepi/client-core";
import { type ReactNode, useMemo, useState, useSyncExternalStore } from "react";
import { projectLabels } from "../lib/project-label";
import { emitTaskNavAction, readTaskNav, subscribeTaskNav } from "../lib/scheduled-task-nav";
import { Icon } from "../vendor/oc-icons";

/**
 * Task center SECOND-TIER PANEL — occupies the app's sidebar slot, the same
 * place the home session list uses. It is NOT a column inside
 * ScheduledTasksPage: a column there disappears on the empty state and sits
 * to the right of the slot, which is why the earlier attempt still looked
 * like one container with three tabs.
 *
 * Markup follows the shared `gui-side-panel.css` spec (rail → one panel →
 * content): primary action, one compact tools row, flat sections, full-width
 * hover rows. Data comes from the page through `lib/scheduled-task-nav` —
 * one cron.list source, one selected id. This component sends actions; the
 * page owns all mutations. Rendering it in the shell also means it stays
 * visible on the empty state and folds/peeks with the rest of the two-tier
 * shell.
 *
 * The same component is the Cordis plugin `sidebar.panel.scheduled` surface
 * (see `src/plugins/scheduled-panel/`). A plugin slot mount cannot pass
 * geometry props, so width comes from `--gui-side-w` on the keeper; direct
 * mounts and contract tests may pass `width`/`collapsed` explicitly.
 */

type StatusFilter = "all" | "enabled" | "paused" | "failed";

export function ScheduledTasksPanel({
	width,
	collapsed,
}: {
	/** Optional geometry override; plugin mounts inherit the CSS variable. */
	width?: number;
	collapsed?: boolean;
}): ReactNode {
	const nav = useSyncExternalStore(subscribeTaskNav, readTaskNav, readTaskNav);
	const [query, setQuery] = useState("");
	const [filter, setFilter] = useState<StatusFilter>("all");

	const visible = useMemo(() => {
		const q = query.trim().toLowerCase();
		return nav.tasks.filter(task => {
			if (q && !task.name.toLowerCase().includes(q) && !task.cwd.toLowerCase().includes(q)) return false;
			if (filter === "enabled" && !task.enabled) return false;
			if (filter === "paused" && task.enabled) return false;
			if (filter === "failed" && task.lastStatus !== "error") return false;
			return true;
		});
	}, [nav.tasks, query, filter]);

	const groups = useMemo(() => {
		const byCwd = new Map<string, typeof visible>();
		for (const task of visible) {
			const key = task.cwd.trim() || "~";
			const list = byCwd.get(key) ?? [];
			list.push(task);
			byCwd.set(key, list);
		}
		return [...byCwd.entries()]
			.sort(([a], [b]) => (a === "~" ? -1 : b === "~" ? 1 : a.localeCompare(b)))
			.map(([cwd, tasks]) => ({ cwd, tasks: [...tasks].sort((a, b) => a.name.localeCompare(b.name)) }));
	}, [visible]);
	const labels = useMemo(() => projectLabels(groups.map(group => group.cwd)), [groups]);

	return (
		<aside
			className={`gui-pane-side gui-pane-side--immersive gui-scheduled-slot gui-side-panel flex h-full flex-shrink-0 flex-col overflow-hidden${collapsed ? " gui-pane-side--collapsed" : ""}`}
			style={width === undefined ? undefined : { width: collapsed ? 0 : width }}
			aria-label={t("settings.scheduledTasks")}
		>
			<div className="gui-pane-drag flex h-9 flex-shrink-0 items-center justify-end pr-2" />
			<div className="gui-side-panel-head">
				{/* No panel heading: the destination title already lives in the
				 * content header. A second one is exactly the redundant chrome
				 * the two-tier spec forbids; the count belongs to each group. */}
				<button
					type="button"
					className="gui-side-panel-primary"
					disabled={nav.busy}
					onClick={() => emitTaskNavAction({ type: "new" })}
				>
					<Icon name="add" className="h-3.5 w-3.5" />
					<span>{t("settings.scheduledNew")}</span>
				</button>
				<div className="gui-side-panel-tools">
					<label className="gui-side-panel-search">
						<Icon name="search" className="h-3.5 w-3.5 shrink-0" />
						<input
							value={query}
							onChange={event => setQuery(event.target.value)}
							placeholder={t("settings.search")}
							aria-label={t("settings.search")}
						/>
					</label>
					<select
						className="gui-side-panel-filter"
						value={filter}
						onChange={event => setFilter(event.target.value as StatusFilter)}
						aria-label={t("settings.scheduledFilterStatus")}
					>
						<option value="all">{t("settings.scheduledFilterAll")}</option>
						<option value="enabled">{t("settings.scheduledEnabled")}</option>
						<option value="paused">{t("settings.scheduledFilterPaused")}</option>
						<option value="failed">{t("settings.scheduledFilterFailed")}</option>
					</select>
				</div>
			</div>
			<div className="gui-side-panel-scroll">
				{groups.length === 0 ? (
					/* The content area owns the full empty state. The panel keeps
					 * a compact one-line hint at the top of the list region —
					 * no second illustration, no vertically centered duplicate. */
					<div className="gui-side-panel-empty">
						<div className="gui-side-panel-empty-title">
							{nav.tasks.length === 0 ? t("settings.scheduledPanelEmpty") : t("settings.scheduledNoMatches")}
						</div>
						{nav.tasks.length === 0 && (
							<div className="gui-side-panel-empty-desc">{t("settings.scheduledPanelEmptyHint")}</div>
						)}
					</div>
				) : (
					groups.map(group => (
						<div key={group.cwd} className="gui-side-panel-section">
							<div className="gui-side-panel-section-title">
								<Icon name="folder-3" className="h-3.5 w-3.5 shrink-0" />
								<span title={group.cwd}>{labels.get(group.cwd) ?? group.cwd}</span>
								<span className="gui-side-panel-count">{group.tasks.length}</span>
							</div>
							{group.tasks.map(task => (
								<button
									key={task.id}
									type="button"
									className={`gui-side-panel-row${nav.selectedId === task.id ? " gui-side-panel-row--active" : ""}`}
									onClick={() => emitTaskNavAction({ type: "select", id: task.id })}
								>
									<span className="gui-side-panel-row-dot" />
									<span className="gui-side-panel-row-label">
										{task.name || t("settings.scheduledUntitled")}
									</span>
									{!task.enabled && <Icon name="pause" className="gui-side-panel-row-meta h-3 w-3 shrink-0" />}
								</button>
							))}
						</div>
					))
				)}
			</div>
		</aside>
	);
}
