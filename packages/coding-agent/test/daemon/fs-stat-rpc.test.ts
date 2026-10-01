import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FileService } from "../../src/daemon/services/file-service";

/**
 * fs.stat 只读存在性探测契约（侧栏项目列表幽灵清理依赖）：
 * - 存在的目录 / 文件 → exists:true，isDirectory 如实。
 * - 不存在的路径 → exists:false（绝不抛错——探测失败与不存在同义，
 *   调用方只做列表过滤）。
 * - 参数缺失 → exists:false，不抛错。
 *
 * Why this exists: 项目列表曾把 Temp\daemon-viewkey-* 等已删除的测试
 * 工作区永久留在 localStorage 里；GUI 需要一条无副作用的只读 RPC 来
 * 对账磁盘存在性。
 *
 * A regression means: 幽灵目录重新赖在项目列表（探测抛错进 RPC 层），
 * 或真实存在的项目被误报不存在而被清掉。
 */

let dir: string;
let svc: FileService;

beforeAll(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-stat-test-"));
	svc = new FileService({
		fallbackCwd: () => dir,
		ensureFileIndex: () => {
			throw new Error("unused");
		},
	});
});

afterAll(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("fs.stat 存在性探测", () => {
	it("存在的目录：exists:true + isDirectory:true", () => {
		expect(svc.stat({ path: dir })).toEqual({ exists: true, isDirectory: true });
	});

	it("存在的文件：exists:true + isDirectory:false", () => {
		const file = path.join(dir, "a.txt");
		fs.writeFileSync(file, "x");
		expect(svc.stat({ path: file })).toEqual({ exists: true, isDirectory: false });
	});

	it("不存在的路径：exists:false，不抛错", () => {
		expect(svc.stat({ path: path.join(dir, "gone", "nope") })).toEqual({ exists: false, isDirectory: false });
	});

	it("参数缺失：exists:false，不抛错", () => {
		expect(svc.stat({})).toEqual({ exists: false, isDirectory: false });
	});
});
