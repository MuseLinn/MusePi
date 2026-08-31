import "./dom-shim";
import { afterEach, describe, expect, it } from "bun:test";

// dom-shim has no localStorage — provide a minimal Map-backed one so the
// board persistence (loadBoards BOARDS_KEY contract) is testable in Node.
const store = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
	getItem: (k: string) => store.get(k) ?? null,
	setItem: (k: string, v: string) => void store.set(k, v),
	removeItem: (k: string) => void store.delete(k),
};

import {
	BOARDS_KEY,
	type BoardData,
	ensureBuiltinSeeds,
	markBuiltin,
	mergeDaemonBoards,
	nextId,
	overlaps,
	resolveCollisions,
	restoreBuiltinBoards,
	sanitizeBoard,
	seedBoards,
	snap,
} from "../src/lib/board-model";

// 看板模型(board-model)纯逻辑契约:碰撞避免、内建保护、持久化清洗。
// UI(BoardPage)只做交互;这些是"变化原因"独立的数据变换。

function widget(id: string, x: number, y: number, w: number, h: number) {
	return { id, type: "metric", title: id, data: {}, pos: { x, y, w, h } };
}

function board(id: string, widgets: ReturnType<typeof widget>[]): BoardData {
	return { id, title: id, widgets };
}

afterEach(() => {
	localStorage.removeItem(BOARDS_KEY);
});

describe("snap", () => {
	it("对齐到 8px 网格(像素画布状态恒为整数)", () => {
		expect(snap(3)).toBe(0);
		expect(snap(5)).toBe(8);
		expect(snap(12)).toBe(16);
		expect(snap(1090)).toBe(1088);
	});
});

describe("overlaps", () => {
	it("相邻卡(GAP 间距)不算碰撞,重叠才算", () => {
		// GAP-4=8 的 gutter:正好贴着(间距 12)不碰。
		expect(overlaps({ x: 0, y: 0, w: 100, h: 50 }, { x: 112, y: 0, w: 100, h: 50 })).toBe(false);
		expect(overlaps({ x: 0, y: 0, w: 100, h: 50 }, { x: 50, y: 0, w: 100, h: 50 })).toBe(true);
	});
});

describe("resolveCollisions", () => {
	it("碰撞卡被推到 moved 下方,且级联不再互相压", () => {
		const moved = widget("a", 0, 0, 200, 100);
		const w1 = widget("b", 50, 50, 200, 100);
		const w2 = widget("c", 50, 100, 200, 100);
		const next = resolveCollisions([moved, w1, w2], moved, "a");
		const b = next.find(w => w.id === "b")!;
		const c = next.find(w => w.id === "c")!;
		// b 被推到 a 下方
		expect(b.pos.y).toBe(112);
		// c 被 b(已下移)再推,两者不再重叠
		expect(c.pos.y).toBeGreaterThanOrEqual(b.pos.y + b.pos.h);
		expect(overlaps(c.pos, b.pos)).toBe(false);
		// moved 自身不动
		expect(next.find(w => w.id === "a")!.pos).toEqual(moved.pos);
	});
});

describe("markBuiltin / builtin 保护", () => {
	it("按 id 重打 builtin 标记(旧存量数据补旗)", () => {
		expect(markBuiltin({ id: "finance", title: "", widgets: [] }).builtin).toBe(true);
		expect(markBuiltin({ id: "user-board", title: "", widgets: [] }).builtin).toBeUndefined();
	});
});

describe("restoreBuiltinBoards", () => {
	it("内建板恢复种子布局,用户板原样保留", () => {
		const seeds = seedBoards();
		const drifted = structuredClone(seeds);
		drifted[0]!.widgets[0]!.pos = { x: 999, y: 999, w: 10, h: 10 };
		const user = board("user-board", [widget("u1", 0, 0, 100, 100)]);
		const restored = restoreBuiltinBoards([...drifted, user]);
		// finance 回到种子位置
		expect(restored[0]!.widgets[0]!.pos).toEqual(seeds[0]!.widgets[0]!.pos);
		// 用户板不受影响
		expect(restored.find(b => b.id === "user-board")!.widgets[0]!.id).toBe("u1");
	});
});

describe("ensureBuiltinSeeds", () => {
	it("非空存储缺种子时补回,空存储尊重用户清空", () => {
		const seeds = seedBoards();
		expect(ensureBuiltinSeeds([])).toEqual([]);
		const onlyUser = [board("user-board", [])];
		const withSeeds = ensureBuiltinSeeds(onlyUser);
		expect(withSeeds.some(b => b.id === "finance")).toBe(true);
		expect(withSeeds.some(b => b.id === seeds[1]!.id)).toBe(true);
	});
});

describe("mergeDaemonBoards", () => {
	it("追加 daemon 新板(非内建),本地已有板不覆盖", () => {
		const local = [board("mine", [])];
		const daemon = [board("mine", [widget("x", 0, 0, 1, 1)]), markBuiltin(board("agent-created", []))];
		const merged = mergeDaemonBoards(local, daemon);
		expect(merged).toHaveLength(2);
		expect(merged.find(b => b.id === "mine")!.widgets).toHaveLength(0);
		expect(merged.some(b => b.id === "agent-created")).toBe(true);
	});
});

describe("sanitizeBoard", () => {
	it("分数坐标取整;干净板引用不变", () => {
		const frac = board("b1", [widget("w", 10.5, 0, 100.2, 50)]);
		const clean = sanitizeBoard(frac);
		expect(clean.widgets[0]!.pos).toEqual({ x: 11, y: 0, w: 100, h: 50 });
		const already = board("b2", [widget("w", 8, 8, 100, 50)]);
		expect(sanitizeBoard(already)).toBe(already);
	});
});

describe("nextId", () => {
	it("自增不重复", () => {
		expect(nextId("w")).not.toBe(nextId("w"));
	});
});
