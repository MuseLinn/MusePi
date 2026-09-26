/**
 * 会话轨迹数据构建(纯逻辑,无 DOM 依赖):从 MaterializedView entries
 * 构建事件时间线与统计。TrajectoryView 与单元测试共用。
 *
 * 轮次语义与折叠/导航层共用 client-core isTurnStart:user 消息或
 * display:true 的 advisor 笔记各开一轮(stats.turns = 轮起始数,不是
 * assistant 消息数——长会话下后者是前者的数十倍)。
 */
import { isTurnStart } from "@musepi/client-core/src/components/transcript/round-collapse";

export interface TrajectoryEvent {
	id: string;
	kind: "assistant" | "tool" | "system" | "user" | "advisor";
	title: string;
	body?: string;
	result?: string;
	toolCallId?: string;
	turn: number;
	/** 树深度编号(沿父链的根→该条目的轮起始数):branchAt 后新主线轮的
	 *  编号 = 新分支深度(3、4…),不是 journal 追加序(5、6…)。无路径/无
	 *  id 的条目 = undefined,展示层回退 turn。 */
	pathTurn?: number;
	timestamp?: string;
	/** 源 wire entry id — 轨迹行点击跳转 transcript 用。 */
	entryId?: string;
	/** 数值化时间戳(Overview 时间轴投影与区间判定用;无则 undefined)。 */
	tsMs?: number;
	/** 该事件位于分支上(entry parentId ≠ 线性前驱;非当前路径的旁支消息)。 */
	branch?: boolean;
	/** assistant 消息自带用量(wire AssistantMessage.usage,settled 回合才有)。 */
	usage?: TrajectoryUsage;
	/** 该轮模型请求耗时 ms(wire AssistantMessage.duration,settled 才有)。 */
	durationMs?: number;
	/** 首字节延迟 ms(wire AssistantMessage.ttft,settled 才有)。 */
	ttftMs?: number;
}

/** WireUsage 的展示子集(与 usage-row.ts 同源字段)。 */
export interface TrajectoryUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens?: number;
}

export interface TrajectoryStats {
	durationSec: number;
	turns: number;
	calls: number;
	model?: string;
}

function truncate(text: string, max = 220): string {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

function stringifyArgs(args: unknown): string {
	try {
		const s = JSON.stringify(args);
		return s && s.length > 160 ? `${s.slice(0, 160)}…` : (s ?? "");
	} catch {
		return String(args ?? "");
	}
}

/**
 * 构建轨迹事件。activePath(可选)= 当前活跃叶路径上的条目 id 集
 * (GUI 由 leafWalk/pinnedPathIds 提供)。提供时:
 *  - 主线/分支按"是否在活跃路径上"判定(取代 first-child 启发式)——
 *    branchAt/编辑重发后旧分支整链标 branch,新主线轮回到主线列;
 *  - 每个事件带 pathTurn(树深度),branchAt 后的新轮编号 = 新分支深度
 *    (撤回第 2 轮再发问 → 新轮是"第 3 轮",不是 journal 追加序的第 5 轮)。
 * 不提供时保持旧行为(first-child 链 = 主线,追加序编号)。
 */
export function buildTrajectory(
	entries: readonly unknown[],
	activePath?: ReadonlySet<string>,
): { events: TrajectoryEvent[]; stats: TrajectoryStats } {
	const events: TrajectoryEvent[] = [];
	let turn = 0;
	let toolCalls = 0;
	let firstTs: number | undefined;
	let lastTs: number | undefined;
	/** toolCallId → 最近的 TOOL 事件(结果回填)。 */
	const toolIndex = new Map<string, TrajectoryEvent>();
	let branchIds: ReadonlySet<string> | undefined;

	// ── 树深度预计算:parentId 链上(含自身)的轮起始数。一次遍历 + 记忆化,
	// 深链(上万条)不会退化成 O(n²)。轮起始口径与折叠/导航层一致
	// (isTurnStart:user 消息或 display advisor 笔记)。
	const parentOf = new Map<string, string | null>();
	const turnStartIds = new Set<string>();
	for (const raw of entries) {
		if (!raw || typeof raw !== "object") continue;
		const e = raw as { id?: unknown; parentId?: unknown };
		if (typeof e.id !== "string") continue;
		parentOf.set(e.id, typeof e.parentId === "string" ? e.parentId : null);
		if (isTurnStart(raw as Parameters<typeof isTurnStart>[0])) turnStartIds.add(e.id);
	}
	const depthMemo = new Map<string, number>();
	const depthOf = (id: string): number => {
		const hit = depthMemo.get(id);
		if (hit !== undefined) return hit;
		const chain: string[] = [];
		let base = 0;
		let cur: string = id;
		for (;;) {
			const cached = depthMemo.get(cur);
			if (cached !== undefined) {
				base = cached;
				break;
			}
			chain.push(cur);
			const p = parentOf.get(cur);
			if (p === undefined || p === null || !parentOf.has(p)) break; // 根或链断
			cur = p;
		}
		let d = base;
		for (let i = chain.length - 1; i >= 0; i--) {
			if (turnStartIds.has(chain[i]!)) d += 1;
			depthMemo.set(chain[i]!, d);
		}
		return depthMemo.get(id) ?? base;
	};

	for (const raw of entries) {
		if (!raw || typeof raw !== "object") continue;
		const entry = raw as {
			type?: string;
			message?: Record<string, unknown>;
			timestamp?: string;
			id?: string;
			parentId?: string | null;
		};
		const entryId = typeof entry.id === "string" ? entry.id : undefined;
		const ts = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
		const tsMs = Number.isFinite(ts) ? ts : undefined;
		if (tsMs !== undefined) {
			if (firstTs === undefined) firstTs = tsMs;
			lastTs = tsMs;
		}
		const type = entry.type ?? "";
		const msg = entry.message as
			| {
					role?: string;
					content?: unknown;
					toolCallId?: string;
					name?: string;
					arguments?: unknown;
					result?: unknown;
					/** wire AssistantMessage 自带字段(settled 回合才有)。 */
					usage?: TrajectoryUsage;
					duration?: number;
					ttft?: number;
			  }
			| undefined;

		if (type === "message" && msg?.role === "toolResult") {
			// ToolResultMessage:回填对应 TOOL 事件的结果预览。
			const target = toolIndex.get(msg.toolCallId ?? "");
			if (target) {
				const content = Array.isArray(msg.content)
					? (msg.content as Array<{ type?: string; text?: string }>)
							.filter(c => c?.type === "text")
							.map(c => c.text ?? "")
							.join(" ")
					: String(msg.content ?? "");
				target.result = truncate(content || String(msg.result ?? ""), 160);
			}
		} else if (type === "message" && msg) {
			// 分支判定:有活跃路径 = "不在路径上即分支"(branchAt 后旧链整体
			// 入分支列,新主线轮归主线);无路径 = 旧 first-child 启发式。
			let isBranch: boolean;
			if (activePath !== undefined && activePath.size > 0) {
				isBranch = entryId !== undefined && !activePath.has(entryId);
			} else {
				// Branch detection: a message not on the main first-child chain is
				// a branch (re-answer / fork continuation) — the timeline flags
				// it instead of hiding it. Set is computed lazily on first use.
				if (branchIds === undefined) {
					const childrenOf = new Map<string, string[]>();
					const ids = new Set<string>();
					let rootId: string | null = null;
					for (const raw of entries) {
						if (!raw || typeof raw !== "object") continue;
						const e2 = raw as { id?: unknown; parentId?: unknown; type?: unknown };
						if (typeof e2.id !== "string" || e2.type !== "message") continue;
						ids.add(e2.id);
						const pid = e2.parentId === null || typeof e2.parentId !== "string" ? null : e2.parentId;
						if (pid !== null) {
							const arr = childrenOf.get(pid) ?? [];
							arr.push(e2.id);
							childrenOf.set(pid, arr);
						} else if (rootId === null) {
							rootId = e2.id;
						}
					}
					// 主线 = 从根沿 first-child 下行;其余全部 = 分支。
					const main = new Set<string>();
					let cur = rootId;
					while (cur !== null && ids.has(cur)) {
						main.add(cur);
						cur = childrenOf.get(cur)?.[0] ?? null;
					}
					const branch = new Set<string>();
					for (const id of ids) if (!main.has(id)) branch.add(id);
					branchIds = branch;
				}
				isBranch = entryId !== undefined && branchIds.has(entryId);
			}
			const pathTurn = entryId !== undefined ? depthOf(entryId) : undefined;
			if (msg.role === "user") {
				turn += 1;
				const text = Array.isArray(msg.content)
					? msg.content
							.filter((c: { type?: string; text?: string }) => c?.type === "text")
							.map((c: { text?: string }) => c.text ?? "")
							.join(" ")
					: String(msg.content ?? "");
				if (text.trim())
					events.push({
						id: `user:${turn}:${ts}`,
						kind: "user",
						title: truncate(text.trim(), 80),
						turn,
						pathTurn,
						timestamp: entry.timestamp,
						entryId,
						tsMs,
						branch: isBranch || undefined,
					});
				continue;
			}
			if (msg.role === "assistant") {
				const parts = Array.isArray(msg.content) ? msg.content : [];
				let text = "";
				let thinking = "";
				for (const part of parts as Array<{
					type?: string;
					text?: string;
					thinking?: string;
					name?: string;
					id?: string;
					arguments?: unknown;
				}>) {
					if (part?.type === "text" && part.text) text += part.text;
					else if (part?.type === "thinking" && part.thinking) thinking += part.thinking;
					else if (part?.type === "toolCall" && part.name) {
						toolCalls += 1;
						const ev: TrajectoryEvent = {
							id: `tool:${turn}:${part.name}:${toolCalls}`,
							kind: "tool",
							title: part.name,
							body: stringifyArgs(part.arguments),
							turn,
							pathTurn,
							timestamp: entry.timestamp,
							entryId,
							tsMs,
							branch: isBranch || undefined,
						};
						toolIndex.set(part.id ?? ev.id, ev);
						events.push(ev);
					}
				}
				const summary = text.trim() || (thinking.trim() ? `💭 ${truncate(thinking.trim(), 120)}` : "");
				if (summary) {
					events.push({
						id: `assistant:${turn}:${ts}`,
						kind: "assistant",
						title: truncate(summary, 120),
						body: truncate(summary),
						turn,
						pathTurn,
						timestamp: entry.timestamp,
						entryId,
						tsMs,
						// settled 回合的模型请求统计(wire AssistantMessage 原样携带)。
						usage: msg.usage,
						durationMs: msg.duration,
						ttftMs: msg.ttft,
						branch: isBranch || undefined,
					});
				}
			}
		} else if (type === "custom_message" && isTurnStart(raw as Parameters<typeof isTurnStart>[0])) {
			// 顾问(advisor)笔记:与折叠/导航层同一 isTurnStart 口径,各开一轮;
			// 该轮后续 assistant/tool 事件自然归入此 turn。
			turn += 1;
			const c = (raw as { content?: unknown }).content;
			const text =
				typeof c === "string"
					? c
					: Array.isArray(c)
						? (c as Array<{ type?: string; text?: string }>)
								.filter(b => b?.type === "text")
								.map(b => b.text ?? "")
								.join(" ")
						: "";
			events.push({
				id: `advisor:${turn}:${ts}`,
				kind: "advisor",
				title: truncate(text.trim(), 80) || "advisor",
				turn,
				pathTurn: entryId !== undefined ? depthOf(entryId) : undefined,
				timestamp: entry.timestamp,
				entryId,
				tsMs,
			});
		} else if (type === "model_change" || type === "thinking_level_change") {
			// system 事件:title 用原始类型名,组件层映射 i18n(保持纯逻辑无 i18n 依赖)。
			events.push({
				id: `${type}:${ts}`,
				kind: "system",
				title: type,
				turn,
				pathTurn: entryId !== undefined ? depthOf(entryId) : undefined,
				timestamp: entry.timestamp,
				entryId,
				tsMs,
			});
		}
	}

	return {
		events,
		stats: {
			durationSec:
				firstTs !== undefined && lastTs !== undefined ? Math.max(0, Math.round((lastTs - firstTs) / 1000)) : 0,
			// 轮起始数(user + advisor,与折叠/导航/地图同口径)——不是
			// assistant 消息数(长会话下二者差数十倍,用户当作"轮次"读)。
			// 有活跃路径时只数主线轮(废弃分支的轮不占当前会话轮数)。
			turns:
				activePath !== undefined && activePath.size > 0
					? events.filter(e => (e.kind === "user" || e.kind === "advisor") && e.branch !== true).length
					: turn,
			calls: toolCalls,
		},
	};
}

/** 按 turn 分组的轨迹树(events 已带 turn 字段):折叠节点 = turn 摘要
 *  (assistant 标题/调用数/首个时间戳),展开 = 该 turn 事件列表。纯逻辑,
 *  TrajectoryView 与单元测试共用。 */
export interface TrajectoryTurnGroup {
	turn: number;
	/** 展示编号 = 组内事件的树深度(pathTurn);无 = 回退 turn(journal 序)。 */
	displayTurn?: number;
	events: TrajectoryEvent[];
	/** 该 turn 首个事件时间戳(折叠行显示;无则 undefined)。 */
	firstTs?: string;
	/** 该 turn 首个事件数值时间戳(Overview 时间轴投影锚)。 */
	startMs?: number;
	/** 该 turn 末端(最后一个事件;roundDurations 命中时 = start+duration)。 */
	endMs?: number;
	/** 该 turn 完整回合时长(agent_end 冻结值,仅已完成回合有)。 */
	roundDurationMs?: number;
}

/**
 * 归一化 roundDurations(daemon agent_end 冻结的整轮用时,键 = 末条
 * assistant 消息时间戳 ms → 时长 ms)。GUI store 以 Map 形态暴露,持久化
 * 快照/测试以 [number, number][] 形态出现。
 */
export type RoundDurationMap = ReadonlyMap<number, number> | readonly (readonly [number, number])[];

function roundDurationsOf(src: RoundDurationMap | undefined): ReadonlyMap<number, number> {
	if (!src) return new Map();
	if (src instanceof Map) return src;
	const m = new Map<number, number>();
	for (const pair of src) {
		if (Array.isArray(pair) && pair.length === 2 && Number.isInteger(pair[0]) && Number.isInteger(pair[1])) {
			m.set(pair[0] as number, pair[1] as number);
		}
	}
	return m;
}

export function buildTrajectoryTree(
	entries: readonly unknown[],
	roundDurations?: RoundDurationMap,
	activePath?: ReadonlySet<string>,
): {
	turns: TrajectoryTurnGroup[];
	stats: TrajectoryStats;
} {
	const { events, stats } = buildTrajectory(entries, activePath);
	const durations = roundDurationsOf(roundDurations);
	const turns: TrajectoryTurnGroup[] = [];
	for (const ev of events) {
		let group = turns[turns.length - 1];
		if (!group || group.turn !== ev.turn) {
			group = {
				turn: ev.turn,
				displayTurn: ev.pathTurn,
				events: [],
				firstTs: ev.timestamp,
				startMs: ev.tsMs,
			};
			turns.push(group);
		}
		group.events.push(ev);
		// 末端时间 = 组内最后一条带 tsMs 的事件(组内有序,直接覆盖)。
		if (ev.tsMs !== undefined) group.endMs = ev.tsMs;
	}
	// roundDurations 命中:回合锚 = 该 turn 的 assistant 事件 tsMs(agent_end
	// 冻结语义,与 session-store 同源);完整回合闭合 = start + duration。
	for (const group of turns) {
		if (group.startMs === undefined) continue;
		const assistant = group.events.find(e => e.kind === "assistant" && e.tsMs !== undefined);
		const anchor = assistant?.tsMs;
		const duration = anchor !== undefined ? durations.get(anchor) : undefined;
		if (typeof duration === "number" && Number.isFinite(duration) && duration > 0) {
			group.roundDurationMs = duration;
			group.endMs = group.startMs + duration;
		}
	}
	return { turns, stats };
}

/** 事件是否落在 [startMs, endMs] 区间内(Overview 拖拽聚焦的高亮/置灰判定)。
 *  无 tsMs 的事件视为不在区间(区间模式从不误亮未知时刻)。纯逻辑,组件复用。 */
export function isTrajectoryEventInRange(ev: TrajectoryEvent, startMs: number, endMs: number): boolean {
	if (ev.tsMs === undefined) return false;
	return ev.tsMs >= startMs && ev.tsMs <= endMs;
}
