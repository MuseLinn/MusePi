import { describe, expect, it } from "bun:test";
import {
	type ActionStorage,
	DEFAULT_ACTION_ICON,
	type ProjectAction,
	parseProjectActions,
	readProjectActions,
	resolveProjectActionIcon,
	writeProjectActions,
} from "./project-actions";

/**
 * 项目自定义操作的持久化契约（openchamber project-actions 吸收）：
 * localStorage 损坏 / 条目缺字段 / 超量 时，菜单必须仍能渲染且写入的
 * 数据读回等价；未知 icon 回退 play（限定集合校验）。
 */

function fakeStorage(initial: Record<string, string> = {}): ActionStorage & { dump(): Record<string, string> } {
	const map = new Map(Object.entries(initial));
	return {
		getItem: key => (map.has(key) ? (map.get(key) as string) : null),
		setItem: (key, value) => void map.set(key, value),
		dump: () => Object.fromEntries(map),
	};
}

const valid: ProjectAction = { id: "a1", name: "Test", command: "bun test", icon: "hammer" };

describe("parseProjectActions", () => {
	it("drops entries missing id/name/command instead of breaking the menu", () => {
		expect(
			parseProjectActions([
				{ id: "", name: "no id", command: "x" },
				{ id: "a", name: "", command: "x" },
				{ id: "a", name: "no command", command: "  " },
				"junk",
				null,
				valid,
			]),
		).toEqual([valid]);
	});

	it("caps the list at 12 and dedupes ids (first occurrence wins)", () => {
		const many = Array.from({ length: 15 }, (_, i) => ({ id: `k${i}`, name: `n${i}`, command: `c${i}` }));
		const capped = parseProjectActions(many);
		expect(capped.length).toBe(12);
		expect(capped[0]?.id).toBe("k0");

		const deduped = parseProjectActions([valid, { ...valid, name: "dupe" }]);
		expect(deduped.length).toBe(1);
		expect(deduped[0]?.name).toBe("Test");
	});

	it("resolves icons against the limited set and keeps literal autoOpenUrl=true only", () => {
		expect(parseProjectActions([{ id: "a", name: "n", command: "c", icon: "nope" }])[0]?.icon).toBe(
			DEFAULT_ACTION_ICON,
		);
		expect(parseProjectActions([{ id: "a", name: "n", command: "c", icon: "flask" }])[0]?.icon).toBe("flask");
		const withUrl = parseProjectActions([{ id: "a", name: "n", command: "c", autoOpenUrl: true }])[0];
		expect(withUrl?.autoOpenUrl).toBe(true);
		const withFalsyUrl = parseProjectActions([{ id: "a", name: "n", command: "c", autoOpenUrl: "yes" }])[0];
		expect(withFalsyUrl?.autoOpenUrl).toBeUndefined();
	});

	it("rejects non-array payloads (corrupt storage reads as empty)", () => {
		expect(parseProjectActions(null)).toEqual([]);
		expect(parseProjectActions("{oops")).toEqual([]);
		expect(parseProjectActions({ id: "a" })).toEqual([]);
	});
});

describe("resolveProjectActionIcon", () => {
	it("falls back to play for unknown/legacy icon values", () => {
		expect(resolveProjectActionIcon("play")).toBe("play");
		expect(resolveProjectActionIcon("git-branch")).toBe("git-branch");
		expect(resolveProjectActionIcon("nonexistent")).toBe("play");
		expect(resolveProjectActionIcon("")).toBe("play");
	});
});

describe("readProjectActions / writeProjectActions", () => {
	it("round-trips actions per cwd key", () => {
		const storage = fakeStorage();
		const actions: ProjectAction[] = [
			{ id: "a", name: "Lint", command: "bun run lint", icon: "checkbox-circle" },
			{ id: "b", name: "Deploy", command: "make deploy", icon: DEFAULT_ACTION_ICON },
		];
		writeProjectActions("/repo", actions, storage);
		expect(readProjectActions("/repo", storage)).toEqual(actions);
		expect(Object.keys(storage.dump())[0]).toBe("musepi-gui-project-actions-/repo");
	});

	it("keys stay isolated per cwd and unusable cwd/storage is a no-op", () => {
		const storage = fakeStorage();
		writeProjectActions("/repo-a", [valid], storage);
		expect(readProjectActions("/repo-b", storage)).toEqual([]);
		writeProjectActions("", [valid], storage);
		expect(Object.keys(storage.dump()).length).toBe(1);
	});

	it("corrupt stored JSON reads as an empty list, not a throw", () => {
		const storage = fakeStorage({ "musepi-gui-project-actions-/repo": "{broken" });
		expect(readProjectActions("/repo", storage)).toEqual([]);
	});

	it("writes are sanitized (a hand-migrated junk entry cannot persist)", () => {
		const storage = fakeStorage();
		writeProjectActions(
			"/repo",
			[
				{ id: "ok", name: "ok", command: "ok", icon: "play" },
				{ id: "", name: "no id", command: "x", icon: "play" },
			],
			storage,
		);
		expect(readProjectActions("/repo", storage)).toEqual([
			{ id: "ok", name: "ok", command: "ok", icon: DEFAULT_ACTION_ICON },
		]);
	});
});
