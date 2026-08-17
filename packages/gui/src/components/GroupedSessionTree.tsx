import { t } from "@musepi/collab-web";
import type { ReactNode } from "react";
import { type GuiTreeNode, SessionTree } from "./SessionTree";

/** Bucket a timestamp into a date-group label (ZCode groups tab). */
function dateGroup(ts: string): string {
	const d = new Date(ts);
	if (Number.isNaN(d.getTime())) return "";
	const now = new Date();
	const startOfDay = (x: Date): number => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
	const days = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
	if (days <= 0) return t("today");
	if (days === 1) return t("yesterday");
	if (days <= 7) return t("last 7 days");
	return t("earlier");
}

const GROUP_ORDER = ["today", "yesterday", "last 7 days", "earlier"];

/**
 * Date-grouped session list (ZCode groups tab): sessions bucketed into
 * today / yesterday / last 7 days / earlier, each with a section header.
 * Each group renders the shared SessionTree for its roots.
 */
export function GroupedSessionTree({
	nodes,
	selectedId,
	onSelect,
	onContextMenu,
	unread,
	pausedIds,
}: {
	nodes: GuiTreeNode[];
	selectedId: string | null;
	onSelect(id: string): void;
	onContextMenu?(sessionId: string, x: number, y: number): void;
	unread?: ReadonlySet<string>;
	pausedIds?: ReadonlySet<string>;
}): ReactNode {
	const groups = new Map<string, GuiTreeNode[]>();
	for (const n of nodes) {
		const g = dateGroup(n.entry.timestamp) || "earlier";
		const list = groups.get(g) ?? [];
		list.push(n);
		groups.set(g, list);
	}
	const ordered = GROUP_ORDER.filter(g => groups.has(g)).concat(
		[...groups.keys()].filter(g => !GROUP_ORDER.includes(g)),
	);
	if (ordered.length === 0) {
		return <p className="px-2 py-4 text-[13px] text-[var(--color-text-faint)]">{t("no sessions yet")}</p>;
	}
	return (
		<>
			{ordered.map(g => (
				<div key={g} className="mb-1.5">
					{/* ZCode group header: sentence case, low-contrast, generous
					 * spacing — no uppercase, no bright text. */}
					<div className="gui-group-label px-2 pb-1 pt-2.5">{g}</div>
					<SessionTree
						nodes={groups.get(g)!}
						selectedId={selectedId}
						onSelect={onSelect}
						onContextMenu={onContextMenu}
						unread={unread}
						pausedIds={pausedIds}
					/>
				</div>
			))}
		</>
	);
}
