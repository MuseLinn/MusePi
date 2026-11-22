/**
 * 轮地图的「事实投影」:一张轮卡与检视器各自要读的那几个数,从轮组算一次。
 *
 * 为什么单独成模块:卡片与检视器是同一份事实的两个落点(卡片 = 索引行,
 * 检视器 = 明细行),两边各写一遍 `filter(kind === ...).length` 迟早会漂移成
 * 「卡片说 3 条回复、检视器列出 4 行」。这里只做投影,不做排版,也不碰 i18n
 * ——文案属于展示层。
 *
 * 边界(设计契约 docs/gui-design.md § 会话地图信息模型):
 *  - 卡片只拿预览(一行)、轮号、用时、回复/工具计数、在/离路径;
 *  - 检视器拿时间范围、同样的计数,以及逐事件行(kind/标签/耗时);
 *  - 正文不进入任何一边——正文属于对话,由「查看对话」跳转过去看。
 */

import type { TrajectoryEvent, TrajectoryTurnGroup } from "../components/trajectory-data";

/** 卡片预览的字符上限(卡片是单行省略,超出即截断)。 */
const TURN_PREVIEW_CHARS = 90;

/**
 * 卡片的一行预览:轮首非 system 事件的标题。
 *
 * 只取标题不取正文:正文是对话里的东西,卡片重复它就是用户抱怨的「一大块
 * 重复消息文本」。标题在派生层已经截到 80 字,这里只做空白折叠与长度兜底。
 */
export function turnPreview(group: TrajectoryTurnGroup): string {
	const ev = group.events.find(e => e.kind !== "system") ?? group.events[0];
	return (ev?.title ?? "").replace(/\s+/g, " ").trim().slice(0, TURN_PREVIEW_CHARS);
}

/** 卡片与检视器共用的一组计数。 */
export interface TurnFacts {
	replies: number;
	tools: number;
	events: number;
	/** 整轮用时:优先 agent_end 冻结值,否则首末事件差。 */
	durationMs?: number;
}

/** 轮的扫描事实(卡片上的「2 回复 · 5 工具 · 3s」就是这几个数)。 */
export function turnFacts(group: TrajectoryTurnGroup): TurnFacts {
	let replies = 0;
	let tools = 0;
	for (const ev of group.events) {
		if (ev.kind === "assistant") replies += 1;
		else if (ev.kind === "tool") tools += 1;
	}
	const durationMs =
		group.roundDurationMs ??
		(group.startMs !== undefined && group.endMs !== undefined ? group.endMs - group.startMs : undefined);
	return { replies, tools, events: group.events.length, durationMs };
}

/** 检视器的一行:kind + 标签 + 耗时,不含正文。 */
export interface TurnEventRow {
	id: string;
	kind: TrajectoryEvent["kind"];
	/** 一行标签(工具 = 工具名;消息 = 已截断的标题)。 */
	label: string;
	/** 该条自身耗时(assistant 的 wire duration),无则回退与上一行的时间差。 */
	elapsedMs?: number;
	/** 绝对时刻(检视器右侧的时钟)。 */
	tsMs?: number;
	/** 可跳转的源条目(「查看对话」落到该行)。 */
	entryId?: string;
}

/**
 * 检视器事件行。
 *
 * `elapsedMs` 的语义是「这一步花了多久」:assistant 行带 wire duration 时用它;
 * 否则用与上一条带 ts 的事件的时间差——工具/用户行没有独立 duration,时间差
 * 是它们唯一诚实的耗时读数。首行没有前驱,只保留绝对时刻。
 */
export function turnEventRows(group: TrajectoryTurnGroup): TurnEventRow[] {
	const rows: TurnEventRow[] = [];
	let prevTs: number | undefined;
	for (const ev of group.events) {
		const gap = ev.tsMs !== undefined && prevTs !== undefined ? ev.tsMs - prevTs : undefined;
		rows.push({
			id: ev.id,
			kind: ev.kind,
			label: ev.title,
			elapsedMs: ev.durationMs ?? (gap !== undefined && gap > 0 ? gap : undefined),
			tsMs: ev.tsMs,
			entryId: ev.entryId,
		});
		if (ev.tsMs !== undefined) prevTs = ev.tsMs;
	}
	return rows;
}

/** 该轮首个可跳转条目(「查看对话」的落点)。 */
export function turnJumpEntryId(group: TrajectoryTurnGroup): string | undefined {
	for (const ev of group.events) if (ev.entryId !== undefined) return ev.entryId;
	return undefined;
}

/**
 * 轮是否在活跃路径之外。
 *
 * `pathIds` = 转录当前真正显示的那批条目 id(见 lib/turn-map-path)。给了就以
 * 它为准——地图与对话必须用同一个答案,否则「地图说这是旁支、对话里它就在
 * 眼前」。没给时退回派生层的 offPath 标记(活跃路径未知 = 无从判断,不淡显)。
 */
export function turnIsOffPath(group: TrajectoryTurnGroup, pathIds?: ReadonlySet<string>): boolean {
	if (pathIds !== undefined) {
		let anyKnown = false;
		for (const ev of group.events) {
			if (ev.entryId === undefined) continue;
			anyKnown = true;
			if (pathIds.has(ev.entryId)) return false;
		}
		// 整轮都没有 entryId(纯展示行):无从判断,不淡显。
		if (anyKnown) return true;
	}
	return group.offPath === true;
}
