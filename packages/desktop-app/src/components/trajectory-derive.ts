/**
 * 轨迹派生增量缓存(P1-11,docs/review/0.5.1-defect-handoff.md)。
 *
 * 失败模式:TrajectoryView 的 memo 依赖(entries / roundDurations /
 * activePathIds)每个流式帧都换引用(store snapshot 每帧 spread 新数组,
 * leafWalk 沿 snap?.entries 重建 → 新 Set),导致 buildTrajectoryTree
 * 每帧对全量历史(全量补全后上万条)跑两遍遍历 + 文本截断——长会话流式
 * 下这是每帧数百 ms 的热路径。depthOf 在父链断裂时跳过记忆化,单次
 * 重算内部再退化为 O(n²)(已在 trajectory-data 内修掉)。
 *
 * 复用形状(turn-derive.ts 先例):store 是 append-only / 尾帧替换语义
 * (upsert 从不就地改内容,只换对象引用),因此「新数组 vs 上次输入」
 * 按对象身份找公共前缀,前缀的派生结果(事件 + 运行态断点)原样复用,
 * 只重跑公共前缀之后的增量片段。验收契约(交接单 P1-11):流式追加一帧
 * 的重算复杂度与新增条目相关、与总条目无关——probe.derivedEntries
 * 计数桩在契约测试里钉死这一点。
 *
 * 正确性边界:
 *  - activePath 内容变化(不是引用变化——GUI 每帧新 Set)会让分支判定
 *    对所有事件失效 → 内容比对,不等即全量重派生;
 *  - 前插(历史分页)公共前缀为 0 → 全量重派生(轮编号整体位移,无法复用);
 *  - 乐观回显等尾部替换 → 公共前缀止于被替换位,断点复用使重跑量 =
 *    被替换条目之后的片段(至多当前轮)。
 */
import {
	buildTrajectory,
	computeBranchIds,
	groupTrajectoryTurns,
	indexTrajectoryBatch,
	initialTrajectoryRunState,
	type RoundDurationMap,
	type TrajectoryEvent,
	type TrajectoryRunState,
	type TrajectoryStats,
	type TrajectoryTurnGroup,
} from "./trajectory-data";

export interface TrajectoryDeriveResult {
	events: TrajectoryEvent[];
	stats: TrajectoryStats;
}

export interface TrajectoryDeriveCache {
	/** 上次输入数组(只用于对象身份比对,不持有语义)。 */
	input: readonly unknown[] | null;
	/** 每条已消费条目之前的运行态快照(checkpoints[i] = 消费第 i 条之前)。
	 *  长度恒 = input.length + 1,末元素 = finalState。 */
	checkpoints: TrajectoryRunState[];
	/** 上次结果(零变更调用原样返回,保持引用稳定,下游 memo 不失效)。 */
	result: TrajectoryDeriveResult | null;
	/** 上次 activePath 引用(快路径)与内容签名(防 GUI 每帧新 Set)。 */
	pathRef: ReadonlySet<string> | undefined;
	pathSig: string | null;
	/** 轨迹树分组缓存:events 引用未变 + roundDurations 内容未变 → 原样返回。 */
	turnsResult: { turns: TrajectoryTurnGroup[]; stats: TrajectoryStats } | null;
	turnsEvents: readonly TrajectoryEvent[] | null;
	roundDurationsSig: string | null;
}

export function createTrajectoryDeriveCache(): TrajectoryDeriveCache {
	return {
		input: null,
		checkpoints: [],
		result: null,
		pathRef: undefined,
		pathSig: null,
		turnsResult: null,
		turnsEvents: null,
		roundDurationsSig: null,
	};
}

/** activePath 内容签名:GUI 每帧传新 Set 引用,同一内容必须视为同一路径。 */
function pathSignature(activePath: ReadonlySet<string> | undefined): string | null {
	if (activePath === undefined) return null;
	let sig = `${activePath.size}:`;
	for (const id of activePath) sig += `${id};`;
	return sig;
}

function samePath(
	cache: TrajectoryDeriveCache,
	activePath: ReadonlySet<string> | undefined,
	sig: string | null,
): boolean {
	if (activePath === cache.pathRef) return true;
	return sig !== null && sig === cache.pathSig;
}

/** 公共前缀长度:两数组按对象身份逐位比对(指针比较,~ns 级)。 */
function commonPrefixLen(a: readonly unknown[], b: readonly unknown[]): number {
	const max = Math.min(a.length, b.length);
	let i = 0;
	while (i < max && a[i] === b[i]) i += 1;
	return i;
}

/**
 * 增量派生轨迹事件。输出与一次性 buildTrajectory 共价(契约测试钉死),
 * 零变更调用返回上次结果引用。
 */
export function deriveTrajectory(
	entries: readonly unknown[],
	activePath: ReadonlySet<string> | undefined,
	cache: TrajectoryDeriveCache,
	probe?: { derivedEntries: number },
): TrajectoryDeriveResult {
	const sig = pathSignature(activePath);
	if (cache.input !== null && samePath(cache, activePath, sig)) {
		const base = commonPrefixLen(entries, cache.input);
		if (base === entries.length && entries.length === cache.input.length) {
			// 零变更(新数组身份、同对象序列)——返回上次结果,引用稳定。
			return cache.result ?? recompute(entries, activePath, cache, sig, probe);
		}
		if (cache.checkpoints[base] !== undefined) {
			return resumeFrom(entries, activePath, cache, sig, base, probe);
		}
	}
	return recompute(entries, activePath, cache, sig, probe);
}

/** 全量重派生:前插 / 路径变更 / 输入缩到缓存之前(undefined 防御)。 */
function recompute(
	entries: readonly unknown[],
	activePath: ReadonlySet<string> | undefined,
	cache: TrajectoryDeriveCache,
	sig: string | null,
	probe?: { derivedEntries: number },
): TrajectoryDeriveResult {
	cache.checkpoints = [];
	const res = buildTrajectory(entries, activePath, {
		batch: indexTrajectoryBatch(entries),
		onState: (index, state) => {
			cache.checkpoints[index] = state;
		},
		probe,
	});
	cache.checkpoints.push(res.finalState);
	finish(cache, entries, activePath, sig, res.events, res.finalState);
	return cache.result ?? panic();
}

/** 断点续派生:只重跑公共前缀之后的增量片段,前缀事件按断点拼接。 */
function resumeFrom(
	entries: readonly unknown[],
	activePath: ReadonlySet<string> | undefined,
	cache: TrajectoryDeriveCache,
	sig: string | null,
	base: number,
	probe?: { derivedEntries: number },
): TrajectoryDeriveResult {
	const startCp = cache.checkpoints[base] ?? initialTrajectoryRunState();
	// 无活跃路径 → first-child 启发式。既有节点的判定在追加下稳定(首子/
	// 根关系不变),但新增条目必须进集合——每次用全量输入算一份新的经
	//  init 注入(buildTrajectory 只拿到增量片段,就地惰性算缺前缀条目,
	//  复用旧集合则新条目永远拿不到分支判定)。
	const init: TrajectoryRunState =
		activePath !== undefined && activePath.size > 0 ? startCp : { ...startCp, branchIds: computeBranchIds(entries) };
	const keepEvents = startCp.eventCount;
	cache.checkpoints.length = base;
	const suffix = entries.slice(base);
	const res = buildTrajectory(suffix, activePath, {
		init,
		batch: indexTrajectoryBatch(entries),
		onState: (index, state) => {
			cache.checkpoints[base + index] = state;
		},
		probe,
	});
	cache.checkpoints.push(res.finalState);
	const prev = cache.result;
	const events = keepEvents > 0 && prev !== null ? [...prev.events.slice(0, keepEvents), ...res.events] : res.events;
	finish(cache, entries, activePath, sig, events, res.finalState);
	return cache.result ?? panic();
}

/** 统计从最终运行态 + 全量事件重算(suffix-only 的 buildTrajectory 统计
 *  只覆盖增量片段,不能直接用),语义与一次性 buildTrajectory 完全一致。 */
function finish(
	cache: TrajectoryDeriveCache,
	entries: readonly unknown[],
	activePath: ReadonlySet<string> | undefined,
	sig: string | null,
	events: TrajectoryEvent[],
	finalState: TrajectoryRunState,
): void {
	const { firstTs, lastTs, turn, toolCalls } = finalState;
	const stats: TrajectoryStats = {
		durationSec:
			firstTs !== undefined && lastTs !== undefined ? Math.max(0, Math.round((lastTs - firstTs) / 1000)) : 0,
		turns:
			activePath !== undefined && activePath.size > 0
				? events.filter(e => (e.kind === "user" || e.kind === "advisor") && e.branch !== true).length
				: turn,
		calls: toolCalls,
	};
	cache.input = entries;
	cache.result = { events, stats };
	cache.pathRef = activePath;
	cache.pathSig = sig;
}

function panic(): never {
	throw new Error("deriveTrajectory: finish() did not set result");
}

function roundDurationsSignature(rd: RoundDurationMap | undefined): string {
	if (!rd) return "";
	let sig: string;
	if (rd instanceof Map) {
		sig = `${rd.size}:`;
		for (const [k, v] of rd) sig += `${k}=${v};`;
	} else if (Array.isArray(rd)) {
		sig = `${rd.length}:`;
		for (const p of rd) sig += `${p[0]}=${p[1]};`;
	} else {
		// ReadonlyMap 形态(非 Map 实例)。
		const ro = rd as ReadonlyMap<number, number>;
		sig = `${ro.size}:`;
		for (const [k, v] of ro) sig += `${k}=${v};`;
	}
	return sig;
}

/**
 * 增量派生轨迹树(分组层同样带缓存):events 引用未变 +
 * roundDurations 内容未变 → 上次 {turns, stats} 原样返回。
 */
export function deriveTrajectoryTree(
	entries: readonly unknown[],
	roundDurations: RoundDurationMap | undefined,
	activePath: ReadonlySet<string> | undefined,
	cache: TrajectoryDeriveCache,
	probe?: { derivedEntries: number },
): { turns: TrajectoryTurnGroup[]; stats: TrajectoryStats } {
	const { events, stats } = deriveTrajectory(entries, activePath, cache, probe);
	const rdSig = roundDurationsSignature(roundDurations);
	if (cache.turnsResult !== null && cache.turnsEvents === events && cache.roundDurationsSig === rdSig) {
		return cache.turnsResult;
	}
	const turns = groupTrajectoryTurns(events, roundDurations);
	cache.turnsResult = { turns, stats };
	cache.turnsEvents = events;
	cache.roundDurationsSig = rdSig;
	return cache.turnsResult;
}
