import { describe, expect, it } from "bun:test";
import { buildTrajectoryTree } from "../src/components/trajectory-data";
import { layoutTurnMap } from "../src/components/turn-map-layout";
import { filterVisibleEntries, walkLeafPath } from "../src/lib/leaf-walk";
import { transcriptPathIds, visibleEntryIds } from "../src/lib/turn-map-path";

/**
 * 地图的离路径集 == 转录的排除集。
 *
 * 这是 M82 留给 M83 的那条 P2:`trustedPathIds` 交给地图的是 walk/pin 的原始
 * id 集,而转录按 `filterVisibleEntries` 过滤——后者还套着 daemon 只回 200 条
 * 的窗口边界。两个界面于是对同一份会话给出不同答案。
 *
 * 断言形状:把「转录实际显示的那批条目」投影成交给地图的集合,再看地图判出的
 * 旁支轮,必须**恰好**是转录排除掉的那些轮。两种形态都要过:
 *  1. 完整 walk(线性会话 / 拓扑可信);
 *  2. 截断 walk + 已加载窗口(pin 的路径只覆盖尾部,窗口外是真实历史)。
 */

interface Entry {
	type: string;
	id: string;
	parentId: string | null;
	timestamp: string;
	message: { role: string; content: string };
}

function msg(id: string, parentId: string | null, role = "user"): Entry {
	return { type: "message", id, parentId, timestamp: id, message: { role, content: `c-${id}` } };
}

/** 线性 N 轮(id = u1/a1 …)。 */
function linear(turns: number, startParent: string | null = null): Entry[] {
	const entries: Entry[] = [];
	let parent = startParent;
	for (let turn = 1; turn <= turns; turn++) {
		entries.push(msg(`u${turn}`, parent));
		entries.push(msg(`a${turn}`, `u${turn}`, "assistant"));
		parent = `a${turn}`;
	}
	return entries;
}

type Turn = { turn: number; events: { entryId?: string }[] };

/** 地图判出的旁支轮。 */
function mapOffPathTurns(entries: readonly Entry[], visible: readonly Entry[], turns: readonly Turn[]): number[] {
	const pathIds = transcriptPathIds(entries, visible);
	const layout = layoutTurnMap(turns, { pathIds: pathIds ?? undefined });
	return layout.nodes.filter(n => n.offPath).map(n => n.group.turn);
}

/** 转录排除掉的轮:轮内**每一条**可识别条目都不在可见集里。 */
function transcriptExcludedTurns(visible: readonly Entry[], turns: readonly Turn[]): number[] {
	const visibleIds = visibleEntryIds(visible);
	const result: number[] = [];
	for (const group of turns) {
		const ids = group.events.map(e => e.entryId).filter((id): id is string => id !== undefined);
		if (ids.length > 0 && ids.every(id => !visibleIds.has(id))) result.push(group.turn);
	}
	return result;
}

describe("地图与转录对「在不在路径上」给同一个答案", () => {
	it("完整 walk + 线性会话:两边都没有旁支", () => {
		const entries = linear(3);
		const walk = walkLeafPath(entries, "a3");
		expect(walk.complete).toBe(true);
		const activePathIds = new Set(walk.path.map(p => p.id));
		const visible = filterVisibleEntries(entries, walk, activePathIds, { pinnedToRoot: false });
		const { turns } = buildTrajectoryTree(entries, undefined, activePathIds);

		expect(mapOffPathTurns(entries, visible, turns)).toEqual(transcriptExcludedTurns(visible, turns));
		expect(mapOffPathTurns(entries, visible, turns)).toEqual([]);
	});

	it("完整 walk + 真分支:被撤回的兄弟分支在两边都被判成旁支", () => {
		const entries = [
			msg("u1", null),
			msg("a1", "u1", "assistant"),
			// 分支 A(被撤回)
			msg("u2", "a1"),
			msg("a2", "u2", "assistant"),
			// 分支 B(活跃)
			msg("u3", "a1"),
			msg("a3", "u3", "assistant"),
		];
		const walk = walkLeafPath(entries, "a3");
		expect(walk.complete).toBe(true);
		const activePathIds = new Set(walk.path.map(p => p.id));
		const visible = filterVisibleEntries(entries, walk, activePathIds, { pinnedToRoot: false });
		expect(visible.map(e => e.id)).toEqual(["u1", "a1", "u3", "a3"]);

		const { turns } = buildTrajectoryTree(entries, undefined, activePathIds);
		const mapOff = mapOffPathTurns(entries, visible, turns);
		expect(mapOff).toEqual(transcriptExcludedTurns(visible, turns));
		expect(mapOff).toContain(2);
		expect(mapOff).not.toContain(3);
	});

	it("尾部 parentId 全为 null:地图不再把整条 live 会话涂成旁支", () => {
		// 实机形态:live wire 消息不带 parentId,尾部整段 parentless。walk 把它
		// 读成一条从假根起的路径,但转录按全量显示——地图必须一致:没有旁支。
		const entries = [msg("u1", null), msg("a1", null, "assistant"), msg("u2", null), msg("a2", null, "assistant")];
		const walk = walkLeafPath(entries, "a2");
		const activePathIds = new Set(walk.path.map(p => p.id));
		const visible = filterVisibleEntries(entries, walk, activePathIds, { pinnedToRoot: false });
		const { turns } = buildTrajectoryTree(entries, undefined, activePathIds);

		const pathIds = transcriptPathIds(entries, visible);
		expect(pathIds).not.toBeNull();
		expect(pathIds!.size).toBe(entries.length);
		const layout = layoutTurnMap(turns, { pathIds: pathIds! });
		expect(layout.nodes.filter(n => n.offPath)).toHaveLength(0);
	});

	it("截断 walk + 窗口:窗口外的历史轮不被涂成旁支", () => {
		// 40 轮 + 一条从 a30 分出的旧分支(排在尾部,故 journal 序 = 第 41 轮)。
		// daemon 的权威路径只覆盖最后 30 条加载条目;窗口起点之前的历史由 walk
		// 决定。地图必须把 1-20 轮当历史,而不是旁支。
		const entries = [...linear(40), msg("uOld", "a30"), msg("aOld", "uOld", "assistant")];
		const walk = walkLeafPath(entries, "a40");
		expect(walk.complete).toBe(true);
		const activePathIds = new Set(walk.path.map(p => p.id));
		// daemon 路径 = 活跃路径 ∩ 尾部窗口(daemon 只回 TAIL_ENTRIES 条)。
		const windowIds = new Set(entries.slice(-30).map(e => e.id));
		const daemonPath = new Set([...activePathIds].filter(id => windowIds.has(id)));
		const visible = filterVisibleEntries(entries, walk, activePathIds, {
			authoritativePathIds: daemonPath,
			pinnedToRoot: false,
		});

		const { turns } = buildTrajectoryTree(entries, undefined, activePathIds);
		const mapOff = mapOffPathTurns(entries, visible, turns);
		expect(mapOff).toEqual(transcriptExcludedTurns(visible, turns));
		// 头部历史一轮都不能被误判——这正是 M82 报告的那 1-30 轮。
		expect(mapOff.every(turn => turn === 41)).toBe(true);
		expect(mapOff).toContain(41);
	});

	it("截断 walk(叶的父链在窗外)+ 窗口:历史与旁支都各自归位", () => {
		// 加载窗从会话中段开始:首条加载条目的 parentId 指向窗外 → walk 链断。
		// 转录:窗口内按 daemon 路径,窗口外(这里没有)与断链一起按"全显示"。
		const entries = [...linear(40), msg("uOld", "a30"), msg("aOld", "uOld", "assistant")];
		// 模拟分页:只加载了第 21-40 轮 + 旧分支,且首条 parentId 指向窗外。
		const loaded = entries.slice(40);
		const walk = walkLeafPath(loaded, "a40");
		expect(walk.complete).toBe(false);
		const activePathIds = new Set(walk.path.map(p => p.id));
		const windowIds = new Set(loaded.map(e => e.id));
		const daemonPath = new Set([...activePathIds].filter(id => windowIds.has(id)));
		const visible = filterVisibleEntries(loaded, walk, activePathIds, {
			authoritativePathIds: daemonPath,
			pinnedToRoot: false,
		});

		const { turns } = buildTrajectoryTree(loaded, undefined, activePathIds);
		const mapOff = mapOffPathTurns(loaded, visible, turns);
		expect(mapOff).toEqual(transcriptExcludedTurns(visible, turns));
		// 旧分支是唯一被排除的轮(它在窗口内、且不在 daemon 路径上)。
		expect(mapOff).toHaveLength(1);
		expect(turns.find(t => t.turn === mapOff[0]!)!.events[0]!.entryId).toBe("uOld");
	});

	it("转录什么都没排除时,地图没有旁支(线性会话的诚实答案)", () => {
		const entries = linear(2);
		const walk = walkLeafPath(entries, "a2");
		const activePathIds = new Set(walk.path.map(p => p.id));
		const visible = filterVisibleEntries(entries, walk, activePathIds, { pinnedToRoot: false });
		const { turns } = buildTrajectoryTree(entries, undefined, activePathIds);
		const pathIds = transcriptPathIds(entries, visible);
		const layout = layoutTurnMap(turns, { pathIds: pathIds ?? undefined });
		expect(layout.nodes.filter(n => n.offPath)).toHaveLength(0);
		expect(layout.main).toHaveLength(layout.nodes.length);
	});

	it("空会话:没有路径可交(返回 null),地图不编旁支", () => {
		expect(transcriptPathIds([], [])).toBeNull();
	});
});
