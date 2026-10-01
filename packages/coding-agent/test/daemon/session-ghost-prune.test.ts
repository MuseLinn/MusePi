import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { SessionSnapshot } from "@musepi/sdk";
import { DaemonSessionHost, JOURNAL_DIR } from "../../src/daemon/session-host";
import { ViewStore, viewStorePath } from "../../src/daemon/view-store";
import { peekDefaultSessionDir } from "../../src/session/session-paths";
import { isolateAgentDirForTest, restoreAgentDirForTest } from "../helpers/isolate-agent-dir";

/**
 * Ghost 行对账契约：view store 物化行比 transcript 长寿——测试/临时工作区
 * 删除后，store 行仍留在 sessions 表，session.list / 侧栏项目页永远列出死
 * 工作区（pi-advisor-toggle-* / daemon-forkat-* 刷屏事故）。
 *
 * knownSessions 合并时必须对账，非 live 且磁盘证据消失的行从合并结果与
 * view store 一并删除。两种死法：
 * ① transcript 文件消失（store 行的 sessionFile 来自磁盘扫描；TTL 缓存
 *    内文件被删会让该路径陈旧——真实复现「会话文件被单独删除」）；
 * ② store-only 行（activation 物化行，持久层不记路径）的 cwd 对应 slug
 *    目录整个消失（真实复现「测试/临时工作区被整体删除」）。
 * 同时两条负契约：磁盘文件还在的行保留；目录还在的 store-only 行保留
 * （persist 前 lazy 阶段的外部不可见形态，无法证明消失即不动）。
 *
 * Why this exists: 曾有版本只合并不清理，删除/测试工作区在项目列表里
 * 永久残留，只能手动清库。
 *
 * A regression means: 死工作区重新出现在 session.list，或活着的会话行
 * （磁盘文件还在 / store-only 但 slug 目录还在）被误删。
 */

const LIVE_DISK_ID = "01a0e000-1111-7000-9000-000000000001";
const DEAD_FILE_ID = "01a0e000-2222-7000-9000-000000000002";
const DEAD_DIR_ID = "01a0e000-3333-7000-9000-000000000003";
const KEPT_DIR_ID = "01a0e000-4444-7000-9000-000000000004";

let agentDir: string;
let host: DaemonSessionHost;
let store: ViewStore;
let keptCwd: string;
let keptSlug: string;
let deadSlug: string;
let deadDirCwd: string;
let deadDirSlug: string;

function transcript(id: string, cwd: string): string {
	return [
		JSON.stringify({
			type: "session",
			version: 3,
			id,
			cwd,
			timestamp: "2026-10-01T00:00:00.000Z",
		}),
		JSON.stringify({ type: "message", message: { role: "user", content: "hi" } }),
		"",
	].join("\n");
}

function snapshotFor(cwd: string): SessionSnapshot {
	return { cursor: 0, header: {}, entries: [], state: { cwd }, agents: [] } as unknown as SessionSnapshot;
}

beforeAll(async () => {
	agentDir = await isolateAgentDirForTest("ghost-prune-agent-");
	keptCwd = path.join(agentDir, "kept-project");
	deadDirCwd = path.join(agentDir, "gone-temp-dir");
	// slug 目录名必须用真实编码器推导（cwd→slug 规则：home/tmp/abs 作用域），
	// peekDefaultSessionDir 对账分支按同一规则探测目录存在性。
	const sessionsRoot = path.join(agentDir, "sessions");
	keptSlug = peekDefaultSessionDir(keptCwd, sessionsRoot);
	deadSlug = `${peekDefaultSessionDir(keptCwd, sessionsRoot)}-dead`;

	// 真实磁盘结构：活着的会话（transcript 在盘上，slug 目录 = keptCwd 的
	// 编码名约定这里直接用固定名，peek 只按 cwd 推导存在性）。
	await fsp.mkdir(keptSlug, { recursive: true });
	await fsp.mkdir(keptCwd, { recursive: true });
	await fsp.writeFile(
		path.join(keptSlug, `2026-10-01T00-00-00-000Z_${LIVE_DISK_ID}.jsonl`),
		transcript(LIVE_DISK_ID, keptCwd),
	);
	// DEAD_FILE 的 transcript 起初也在盘上（后面测试里单独删文件）。
	await fsp.mkdir(deadSlug, { recursive: true });
	await fsp.writeFile(
		path.join(deadSlug, `2026-10-01T00-00-00-000Z_${DEAD_FILE_ID}.jsonl`),
		transcript(DEAD_FILE_ID, keptCwd),
	);
	// DEAD_DIR 的 slug 目录（会话产物目录）起初也在盘上（后面测试里整体删除）；
	// cwd 目录本身删除与否不影响探测——对账看的是 slug 产物树。
	deadDirSlug = peekDefaultSessionDir(deadDirCwd, sessionsRoot);
	await fsp.mkdir(deadDirSlug, { recursive: true });
	// 放一个占位文件：daemon 构造时的空 slug 清扫会合法地删掉空目录，
	// 本夹具要模拟「有产物的工作区」，必须非空才能活到测试体。
	await fsp.writeFile(path.join(deadDirSlug, "keep.txt"), "x");

	host = new DaemonSessionHost();
	store = new ViewStore(viewStorePath(JOURNAL_DIR));
	// 三行 store 物化行：DEAD_FILE（persist 过、文件将被删）、DEAD_DIR
	// （activation 行、无路径、cwd 目录将被删）、KEPT_DIR（store-only、目录一直在）。
	store.upsert(DEAD_FILE_ID, snapshotFor(keptCwd), null);
	store.upsert(DEAD_DIR_ID, snapshotFor(deadDirCwd), null);
	store.upsert(KEPT_DIR_ID, snapshotFor(keptCwd), null);
}, 30_000);

afterAll(async () => {
	// 共享默认 journal 目录：只清本套件写入的 view-store 行（AGENTS.md 约定）。
	for (const id of [DEAD_FILE_ID, DEAD_DIR_ID, KEPT_DIR_ID]) {
		try {
			store.remove(id);
		} catch {
			// 行已被对账删除即无需清理。
		}
	}
	host.dispose();
	await restoreAgentDirForTest(agentDir);
}, 30_000);

describe("knownSessions 的 ghost 行对账", () => {
	it("磁盘 transcript 还在的会话行保留（对照，同时预热扫描缓存）", async () => {
		const rows = await host.knownSessions();
		expect(rows.some(r => r.sessionId === LIVE_DISK_ID)).toBe(true);
		expect(rows.some(r => r.sessionId === DEAD_FILE_ID)).toBe(true);
		expect(rows.some(r => r.sessionId === DEAD_DIR_ID)).toBe(true);
		expect(rows.some(r => r.sessionId === KEPT_DIR_ID)).toBe(true);
	});

	it("transcript 文件已删的行被对账删除（文件级删除，缓存内 sessionFile 陈旧路径）", async () => {
		// 缓存仍热（10s TTL）：扫描行的 sessionFile 指向刚删的文件，复现
		// 「会话文件被单独删除、工作区目录还在」的幽灵形态。
		await fsp.rm(path.join(deadSlug, `2026-10-01T00-00-00-000Z_${DEAD_FILE_ID}.jsonl`));
		const rows = await host.knownSessions();
		expect(rows.some(r => r.sessionId === DEAD_FILE_ID)).toBe(false);
		// 行还必须从 view store 本体移除，否则重启后又回来。
		expect(store.list().some(r => r.sessionId === DEAD_FILE_ID)).toBe(false);
	});

	it("slug 产物目录整个消失的 store-only 行被对账删除（工作区级删除）", async () => {
		// 复现「测试/临时工作区被整体删除」：slug 产物树没了，store 行还在。
		await fsp.rm(deadDirSlug, { recursive: true, force: true });
		await fsp.rm(deadDirCwd, { recursive: true, force: true });
		const rows = await host.knownSessions();
		expect(rows.some(r => r.sessionId === DEAD_DIR_ID)).toBe(false);
		expect(store.list().some(r => r.sessionId === DEAD_DIR_ID)).toBe(false);
	});

	it("目录还在的 store-only 行不误删（无法证明消失即保留）", async () => {
		const rows = await host.knownSessions();
		expect(rows.some(r => r.sessionId === KEPT_DIR_ID)).toBe(true);
	});
});
