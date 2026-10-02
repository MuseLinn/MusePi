import { describe, expect, it } from "bun:test";
import { subagentParentIdOf } from "../../src/session/session-listing";

/**
 * 子代理 transcript 路径 → 父会话 id 推导契约。
 * 失败模式:session.list 的层级嵌套与 deleteSession 的级联收集各写一份
 * 推导,一份漂移后父删除漏掉子行(列表仍嵌套)或级联误伤无关会话。
 * 单一实现(subagentParentIdOf)供两处消费,这里钉死转换的分支:
 * 时间戳_父id 基名取 id 段、id 含下划线不切错、非深度 3 路径/无 id 段
 * 返回 null、自身路径不自分。
 */
describe("subagentParentIdOf", () => {
	it("深度 3 路径:取父文件基名的时间戳之后的 id 段", () => {
		expect(subagentParentIdOf("sessions/slug/1699_abc123/sub9.jsonl")).toBe("abc123");
	});

	it("父 id 含下划线:只剥时间戳前缀,不切错", () => {
		expect(subagentParentIdOf("sessions/slug/1699_abc_123/sub9.jsonl")).toBe("abc_123");
	});

	it("深度 2 顶层 transcript:基名是 slug,无 id 段 → null", () => {
		expect(subagentParentIdOf("sessions/slug/1699_abc123.jsonl")).toBe(null);
	});

	it("父基名无下划线(纯 slug 目录):无 id 段 → null", () => {
		expect(subagentParentIdOf("sessions/slug/parentdir/sub9.jsonl")).toBe(null);
	});

	it("自身即父(父基名 id 与文件 id 相同):不自分 → null", () => {
		expect(subagentParentIdOf("sessions/slug/1699_same/same.jsonl")).toBe(null);
	});
});
