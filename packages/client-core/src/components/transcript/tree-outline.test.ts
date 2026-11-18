import { describe, expect, test } from "bun:test";
import type { SessionEntry } from "@musepi/pi-wire";
import { deriveTreeOutline, shouldShowTreeNav } from "./tree-outline";

const user = (id: string, parentId: string | null, text = "hi"): SessionEntry =>
	({
		id,
		parentId,
		timestamp: "0",
		type: "message",
		message: { role: "user", content: text, timestamp: 1 },
	}) as unknown as SessionEntry;

const assistant = (id: string, parentId: string | null, text = "ok"): SessionEntry =>
	({
		id,
		parentId,
		timestamp: "0",
		type: "message",
		message: { role: "assistant", content: [{ type: "text", text }], timestamp: 2 },
	}) as unknown as SessionEntry;

/** 顾问卡:同一父节点下的 custom 展示卡,不构成会话分叉。 */
const advisorCard = (id: string, parentId: string | null): SessionEntry =>
	({
		id,
		parentId,
		timestamp: "0",
		type: "message",
		message: { role: "custom", customType: "advisor", content: "note", display: true, timestamp: 3 },
	}) as unknown as SessionEntry;

const TIP = { mode: "tip" } as const;

describe("deriveTreeOutline", () => {
	test("linear session: path runs root → tip and is trustworthy", () => {
		const entries = [user("u1", null), assistant("a1", "u1")];
		const outline = deriveTreeOutline(entries, TIP);
		expect(outline.path.map(n => n.id)).toEqual(["u1", "a1"]);
		expect(outline.complete).toBe(true);
		expect(outline.leafId).toBe("a1");
		expect(outline.leafIsHistorical).toBe(false);
		expect(outline.leafLabel).toBe("ok");
		// 线性会话没有可导航的树,面包屑只是噪声。
		expect(shouldShowTreeNav(outline)).toBe(false);
	});

	test("branch point: two replies under one prompt make the nav worth showing", () => {
		const entries = [user("u1", null), assistant("a1", "u1"), assistant("b1", "u1")];
		const outline = deriveTreeOutline(entries, TIP);
		expect(outline.childCount.get("u1")).toBe(2);
		expect(outline.path.map(n => n.id)).toEqual(["u1", "b1"]);
		expect(outline.leafIsHistorical).toBe(false);
		expect(shouldShowTreeNav(outline)).toBe(true);
	});

	test("pinned leaf with children is historical — sending would fork", () => {
		const entries = [user("u1", null), assistant("a1", "u1"), assistant("a2", "a1")];
		const outline = deriveTreeOutline(entries, { mode: "node", id: "a1" });
		expect(outline.path.map(n => n.id)).toEqual(["u1", "a1"]);
		expect(outline.leafId).toBe("a1");
		expect(outline.leafIsHistorical).toBe(true);
		expect(outline.leafLabel).toBe("ok");
		expect(shouldShowTreeNav(outline)).toBe(true);
	});

	test("custom display cards do not create branches", () => {
		const entries = [user("u1", null), assistant("a1", "u1"), advisorCard("c1", "u1")];
		const outline = deriveTreeOutline(entries, TIP);
		expect(outline.childCount.get("u1")).toBe(1);
		expect(outline.childCount.has("c1")).toBe(false);
		expect(outline.leafIsHistorical).toBe(false);
		expect(shouldShowTreeNav(outline)).toBe(false);
	});

	test("root pin empties the path but stays trustworthy", () => {
		const entries = [user("u1", null), assistant("a1", "u1")];
		const outline = deriveTreeOutline(entries, { mode: "root" });
		expect(outline.path).toEqual([]);
		expect(outline.complete).toBe(true);
		expect(outline.leafId).toBeNull();
		expect(outline.leafIsHistorical).toBe(false);
		expect(shouldShowTreeNav(outline)).toBe(false);
	});

	test("cut chain reports incomplete but still renders the loaded run", () => {
		// 历史窗口截断:最早一行的 parentId 指向窗口外。路径仍可算出来,分支点
		// 也可能落在其中;链首的省略号(渲染层)负责说明上面还有内容。
		const entries = [assistant("a1", "gone"), user("u2", "a1"), assistant("a2", "u2")];
		const outline = deriveTreeOutline(entries, TIP);
		expect(outline.path.map(n => n.id)).toEqual(["a1", "u2", "a2"]);
		expect(outline.complete).toBe(false);
	});

	test("a parentless entry mid-window is a cut, not a root", () => {
		// 发射端漏打 parentId:尾顾问卡 parentless,但它在最老条目之后。
		const entries = [user("u1", null), assistant("a1", "u1"), assistant("orphan", null)];
		const outline = deriveTreeOutline(entries, TIP);
		expect(outline.complete).toBe(false);
	});

	test("session prologue shares the root with the first message", () => {
		const prologue = {
			id: "m1",
			parentId: null,
			timestamp: "0",
			type: "model_change",
			model: "provider/id",
		} as unknown as SessionEntry;
		const entries = [prologue, user("u1", null), assistant("a1", "u1")];
		const outline = deriveTreeOutline(entries, TIP);
		expect(outline.complete).toBe(true);
		expect(outline.path.map(n => n.id)).toEqual(["u1", "a1"]);
	});

	test("a pinned leaf outside the loaded window falls back to the tip", () => {
		// 重连后窗口被截断,显式 leaf 已不在 entries 里 —— 空白面包屑会读成
		// "树丢了",退回尖端仍是用户眼前那条路径。
		const entries = [user("u1", null), assistant("a1", "u1")];
		const outline = deriveTreeOutline(entries, { mode: "node", id: "missing" });
		expect(outline.leafId).toBe("a1");
		expect(outline.path.map(n => n.id)).toEqual(["u1", "a1"]);
	});

	test("empty session has nothing to show", () => {
		const outline = deriveTreeOutline([], TIP);
		expect(outline.path).toEqual([]);
		expect(outline.leafId).toBeNull();
		expect(outline.leafLabel).toBe("");
		expect(shouldShowTreeNav(outline)).toBe(false);
	});
});
