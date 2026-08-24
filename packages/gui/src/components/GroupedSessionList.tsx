import { t } from "@musepi/desktop-web";
import type { ReactNode } from "react";
import { SessionList, type SessionListNode, type SessionStatus } from "./SessionList";

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
 * Date-grouped **会话列表**(ZCode groups tab):sessions bucketed into
 * today / yesterday / last 7 days / earlier, each with a section header.
 * Each group renders the shared SessionList for its roots.
 *
 * ⚠️ 命名:这是会话列表按日期分组,**不是消息树**(TUI `/tree` 语义)。
 * 会话内消息树的构建与载体是 `lib/message-tree.ts`(buildMessageTree)——
 * 轨迹面板未来的「时间线/分支树」切换与 TUI `/trace` 共用它。
 */
export function GroupedSessionList({
	nodes,
	selectedId,
	onSelect,
	onContextMenu,
	unread,
	pausedIds,
	workingIds,
	statuses,
	manualTags,
}: {
	nodes: SessionListNode[];
	selectedId: string | null;
	onSelect(id: string): void;
	onContextMenu?(sessionId: string, x: number, y: number): void;
	unread?: ReadonlySet<string>;
	pausedIds?: ReadonlySet<string>;
	workingIds?: ReadonlySet<string>;
	/** Lifecycle status per session id — tints member rows' left square. */
	statuses?: ReadonlyMap<string, SessionStatus>;
	/** User-assigned color per session id (manual override of status). */
	manualTags?: ReadonlyMap<string, SessionStatus>;
}): ReactNode {
	const groups = new Map<string, SessionListNode[]>();
	for (const n of nodes) {
		// Bucket by LAST-ACTIVITY (openchamber `time.updated` parity, the same
		// key the in-group SessionList sorts by): a session created last week
		// but resumed today belongs under "today", not "earlier" (creation
		// time). Fall back to the creation timestamp for old daemons.
		const g = dateGroup(n.entry.updatedAt ?? n.entry.timestamp) || "earlier";
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
					<SessionList
						nodes={groups.get(g)!}
						selectedId={selectedId}
						onSelect={onSelect}
						onContextMenu={onContextMenu}
						unread={unread}
						pausedIds={pausedIds}
						workingIds={workingIds}
						statuses={statuses}
						manualTags={manualTags}
					/>
				</div>
			))}
		</>
	);
}
