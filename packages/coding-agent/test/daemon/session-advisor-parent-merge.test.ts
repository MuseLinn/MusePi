import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { SessionSnapshot } from "@musepi/sdk";
import { DaemonSessionHost, JOURNAL_DIR } from "../../src/daemon/session-host";
import { ViewStore, viewStorePath } from "../../src/daemon/view-store";
import { isolateAgentDirForTest, restoreAgentDirForTest } from "../helpers/isolate-agent-dir";

/**
 * 顾问/子会话 parentId 回填契约：激活过的子/顾问 transcript 在 view store
 * 留有物化行（activation 写入，无层级字段，parent_id = NULL）。knownSessions
 * 合并磁盘扫描时，existing 分支必须连 parentId 一起回填——session.tree 按
 * parentId 挂父节点，缺它激活过的顾问行被提为顶层孤立行（磁盘结构完好：
 * 父 jsonl + `<parentBase>/__advisor.jsonl` 都在）。
 *
 * Why this exists: 顾问行被点击激活后 journal/store 行以顾问文件头内部 id
 * 落库；曾有版本只回填 subagent/advisor 标，parentId 被丢弃，GUI 出现
 * 「孤立的顾问会话」顶层行。
 *
 * A regression means: 激活过的顾问/子会话在 session.tree 中脱离父会话成为
 * 顶层行，或 parentId 被错误地覆盖成非空值。
 */

const PARENT_ID = "01a0ddbf-4aff-7000-95e1-11aa649c50fd";
const ADVISOR_ID = "01a0ddbf-9c84-7000-8f0a-03f821bd36a9";
const PARENT_BASE = `2026-09-26T12-44-56-447Z_${PARENT_ID}`;

let agentDir: string;
let host: DaemonSessionHost;
let store: ViewStore;

function transcriptLines(id: string, firstPrompt: string): string {
	return [
		JSON.stringify({
			type: "session",
			version: 3,
			id,
			cwd: "/repo",
			timestamp: "2026-09-26T12:45:17.316Z",
		}),
		JSON.stringify({ type: "message", message: { role: "user", content: firstPrompt } }),
		"",
	].join("\n");
}

beforeAll(async () => {
	agentDir = await isolateAgentDirForTest("advisor-parent-merge-");
	const root = path.join(agentDir, "sessions", "proj");
	// 磁盘结构照生产：父 jsonl 与 `<parentBase>/__advisor.jsonl` 并存，
	// 顾问文件头内部 id ≠ 父 id（目录名后缀）。
	await fsp.mkdir(path.join(root, PARENT_BASE), { recursive: true });
	await fsp.writeFile(path.join(root, `${PARENT_BASE}.jsonl`), transcriptLines(PARENT_ID, "parent prompt"));
	await fsp.writeFile(path.join(root, PARENT_BASE, "__advisor.jsonl"), transcriptLines(ADVISOR_ID, "advisor note"));
	host = new DaemonSessionHost();
	store = new ViewStore(viewStorePath(JOURNAL_DIR));
}, 30_000);

afterAll(async () => {
	// 共享默认 journal 目录：只清本套件写入的 view-store 行（AGENTS.md 约定）。
	try {
		store.remove(ADVISOR_ID);
	} catch {
		// 行不存在即无需清理。
	}
	await restoreAgentDirForTest(agentDir);
}, 30_000);

describe("激活过的顾问会话在 knownSessions 中保留父级关联", () => {
	it("无 store 行时：磁盘扫描行带 parentId + advisor/subagent 标（对照）", async () => {
		const rows = await host.knownSessions();
		const advisor = rows.find(r => r.sessionId === ADVISOR_ID);
		expect(advisor?.advisor).toBe(true);
		expect(advisor?.subagent).toBe(true);
		expect(advisor?.parentId).toBe(PARENT_ID);
	});

	it("有 store 行（激活过）时：合并回填 parentId，行不脱离父会话", async () => {
		// 模拟激活产物：view store 里以顾问内部 id 落一行，无层级字段。
		store.upsert(
			ADVISOR_ID,
			{ cursor: 0, header: {}, entries: [], state: {}, agents: [] } as unknown as SessionSnapshot,
			null,
		);
		try {
			const rows = await host.knownSessions();
			const advisor = rows.find(r => r.sessionId === ADVISOR_ID);
			expect(advisor).toBeDefined();
			expect(advisor?.advisor).toBe(true);
			expect(advisor?.subagent).toBe(true);
			expect(advisor?.parentId).toBe(PARENT_ID);
		} finally {
			store.remove(ADVISOR_ID);
		}
	});

	it("父会话行本身不被误标为子级", async () => {
		const rows = await host.knownSessions();
		const parent = rows.find(r => r.sessionId === PARENT_ID);
		expect(parent?.subagent ?? false).toBe(false);
		expect(parent?.advisor ?? false).toBe(false);
	});
});
