/**
 * Session fixtures: the sidebar's session tree and the transcripts the real
 * ChatView renders when a demo session is opened.
 *
 * Shapes follow a real daemon: `session.tree` nodes carry an `entry` (id,
 * label, timestamps), `session.list` adds the per-row metadata the sidebar's
 * hover card and status tints read, and `session.resume` answers with the
 * snapshot the open path mounts (entries + state + header + cursor).
 *
 * Values are demo data: a fictional workspace, no paths or names from a real
 * machine. Timestamps are relative to page load so the date groups stay
 * stable ("今天" / "最近 7 天") whenever the site is visited.
 */

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const now = Date.now();

const MODEL = "anthropic/claude-sonnet-4-5";
const CWD = "/home/musepi/Projects/atlas";

function iso(ms) {
	return new Date(ms).toISOString();
}

function user(id, parentId, text, ts) {
	return {
		id,
		parentId,
		timestamp: iso(ts),
		type: "message",
		message: { role: "user", content: text, timestamp: ts },
	};
}

function assistant(id, parentId, ts, content, stopReason = "stop", usage = [2_400, 320, 18_000, 0.012]) {
	const [input, output, cacheRead, cost] = usage;
	return {
		id,
		parentId,
		timestamp: iso(ts),
		type: "message",
		message: {
			role: "assistant",
			content,
			model: MODEL,
			usage: {
				input,
				output,
				cacheRead,
				cacheWrite: 0,
				totalTokens: input + output + cacheRead,
				cost: { total: cost },
			},
			stopReason,
			timestamp: ts,
		},
	};
}

function toolResult(id, parentId, ts, toolCallId, toolName, text, isError = false) {
	return {
		id,
		parentId,
		timestamp: iso(ts),
		type: "message",
		message: {
			role: "toolResult",
			toolCallId,
			toolName,
			content: [{ type: "text", text }],
			isError,
			timestamp: ts,
		},
	};
}

/** One demo session: sidebar rows, snapshot header/state, and its transcript. */
function session({ id, title, modeId, createdAt, updatedAt, entries }) {
	const lastEntry = entries[entries.length - 1];
	return {
		id,
		title,
		modeId,
		createdAt,
		updatedAt,
		entries,
		roundDurations: entries
			.filter(entry => entry.type === "message" && entry.message.role === "user")
			.map(entry => [entry.message.timestamp, lastEntry.message.timestamp - entry.message.timestamp]),
	};
}

const sidebarGroups = session({
	id: "demo-sidebar-groups",
	title: "设计侧栏分组",
	modeId: "design",
	createdAt: now - 2 * DAY - 3 * 60 * MIN,
	updatedAt: now - 18 * MIN,
	entries: [
		user(
			"g1",
			null,
			"侧栏的会话列表现在是平铺的，帮我按日期分组（今天 / 最近 7 天），并在行上标出未读。",
			now - 34 * MIN,
		),
		assistant(
			"g2",
			"g1",
			now - 33 * MIN,
			[
				{
					type: "thinking",
					thinking:
						"分组只该影响排序和组标题，行本身的渲染要复用同一个列表组件——先看现在的结构再动。",
				},
				{
					type: "text",
					text: "先确认现在的列表是怎么组织的：分组应该只包在列表外面，行组件不动。",
				},
				{
					type: "toolCall",
					id: "call-read-grouped",
					name: "read",
					arguments: { path: "packages/desktop-app/src/components/GroupedSessionList.tsx", limit: 40 },
					intent: "读取现有的分组列表",
				},
			],
			"toolUse",
			[1_860, 210, 12_400, 0.0091],
		),
		toolResult(
			"g3",
			"g2",
			now - 33 * MIN + 4_000,
			"call-read-grouped",
			"read",
			"1  /** Bucket a timestamp into a date-group label. */\n2  function dateGroup(ts: string): string {\n3  \tconst days = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);\n4  \tif (days <= 0) return t(\"settings.today\");\n5  \tif (days === 1) return t(\"settings.yesterday\");\n6  \tif (days <= 7) return t(\"settings.last7Days\");\n7  \treturn t(\"settings.earlier\");\n8  }",
		),
		assistant(
			"g4",
			"g3",
			now - 31 * MIN,
			[
				{
					type: "text",
					text: "结构够用，只需要补两处：分组键改用最近活动时间，未读沿用已有的 `messageCount`。",
				},
				{
					type: "toolCall",
					id: "call-edit-groups",
					name: "edit",
					arguments: {
						path: "packages/desktop-app/src/components/GroupedSessionList.tsx",
						old: "const g = dateGroup(n.entry.timestamp)",
						new: "const g = dateGroup(n.entry.updatedAt ?? n.entry.timestamp)",
					},
					intent: "改用最近活动时间分组",
				},
			],
			"toolUse",
			[2_120, 268, 13_800, 0.0102],
		),
		toolResult(
			"g5",
			"g4",
			now - 31 * MIN + 3_000,
			"call-edit-groups",
			"edit",
			"--- a/packages/desktop-app/src/components/GroupedSessionList.tsx\n+++ b/packages/desktop-app/src/components/GroupedSessionList.tsx\n@@ -67,3 +67,3 @@\n-\t\t\tconst g = dateGroup(n.entry.timestamp) || \"earlier\";\n+\t\t\tconst g = dateGroup(n.entry.updatedAt ?? n.entry.timestamp) || \"earlier\";",
		),
		assistant(
			"g6",
			"g5",
			now - 30 * MIN,
			[
				{
					type: "text",
					text: "改完了，分组键和未读标记两处：\n\n- 分组键改用 `entry.updatedAt ?? entry.timestamp`，最近有活动的会话才会浮到今天\n- 未读沿用 `session.list` 的 `messageCount`，与已读游标比对，不新增 RPC\n- 空桶不渲染，侧栏不会多出空行\n\n```ts\nconst key = node.entry.updatedAt ?? node.entry.timestamp;\nconst group = dateGroup(key) || \"earlier\";\n```\n\n侧栏现在只剩两个组：今天和最近 7 天。",
				},
			],
			"stop",
			[2_480, 96, 15_100, 0.0108],
		),
	],
});

const reviewPr = session({
	id: "demo-review-pr128",
	title: "审查 PR #128 的 diff",
	modeId: "work",
	createdAt: now - 2 * DAY - 40 * MIN,
	updatedAt: now - 2 * DAY,
	entries: [
		user("r1", null, "看下 PR #128 的 diff，重点确认重连退避的上限有没有改。", now - 2 * DAY - 26 * MIN),
		assistant(
			"r2",
			"r1",
			now - 2 * DAY - 25 * MIN,
			[
				{
					type: "text",
					text: "先取完整的 diff，再只盯重连那一段。",
				},
				{
					type: "toolCall",
					id: "call-pr-diff",
					name: "bash",
					arguments: { command: "gh pr diff 128 -- patch", intent: "Fetch PR 128 diff" },
					intent: "取 PR #128 的 diff",
				},
			],
			"toolUse",
			[3_120, 184, 21_600, 0.0128],
		),
		toolResult(
			"r3",
			"r2",
			now - 2 * DAY - 25 * MIN + 6_000,
			"call-pr-diff",
			"bash",
			"diff --git a/src/net/reconnect.ts b/src/net/reconnect.ts\n@@ -12,7 +12,7 @@\n-const BACKOFF_MAX_MS = 5_000;\n+const BACKOFF_MAX_MS = 30_000;\n \n-const delay = Math.min(500 * 2 ** attempt, BACKOFF_MAX_MS);\n+const delay = Math.min(1_000 * 2 ** attempt, BACKOFF_MAX_MS);",
		),
		assistant(
			"r4",
			"r3",
			now - 2 * DAY - 24 * MIN,
			[
				{
					type: "text",
					text: "diff 只动了两个常量，没有触碰分支逻辑：\n\n1. 退避上限 5s → 30s\n2. 基数 500ms → 1s\n\n```ts\nconst delay = Math.min(1_000 * 2 ** attempt, 30_000);\n```\n\n需要注意的地方：上限拉长后，前三次重试的间隔变成 1s / 2s / 4s，首帧恢复比以前慢；如果这是为了压住重连风暴，可以接受。",
				},
			],
			"stop",
			[3_480, 214, 23_100, 0.0136],
		),
	],
});

const settingsKeys = session({
	id: "demo-settings-keys",
	title: "设置页快捷键",
	modeId: "work",
	createdAt: now - 5 * DAY - 2 * 60 * MIN,
	updatedAt: now - 5 * DAY,
	entries: [
		user("k1", null, "设置页要加一个快捷键编辑区，按键冲突怎么检测？", now - 5 * DAY - 48 * MIN),
		assistant(
			"k2",
			"k1",
			now - 5 * DAY - 47 * MIN,
			[
				{
					type: "thinking",
					thinking: "快捷键注册表是唯一事实来源，冲突检测应该读它而不是自己再维护一张表。",
				},
				{
					type: "text",
					text: "冲突检测不该另建一张表——键位注册表已经是唯一事实来源，直接读它。",
				},
				{
					type: "toolCall",
					id: "call-grep-keys",
					name: "grep",
					arguments: { pattern: "app\\.session\\.tree|app\\.command\\.palette", path: "packages/coding-agent/src/config" },
					intent: "查键位注册表结构",
				},
			],
			"toolUse",
			[1_940, 152, 11_200, 0.0084],
		),
		toolResult(
			"k3",
			"k2",
			now - 5 * DAY - 47 * MIN + 5_000,
			"call-grep-keys",
			"grep",
			"packages/coding-agent/src/config/keybindings.ts:43:\t\"app.session.tree\": true;\npackages/coding-agent/src/config/keybindings.ts:173:\t\"app.session.tree\": {\npackages/coding-agent/src/config/keybindings.ts:267:\ttree: \"app.session.tree\",",
		),
		assistant(
			"k4",
			"k3",
			now - 5 * DAY - 46 * MIN,
			[
				{
					type: "text",
					text: "注册表里每个动作都有默认键位和可覆盖项，检测分两层：\n\n| 层级 | 判据 | 结果 |\n| --- | --- | --- |\n| 同一动作 | 新旧键位相同 | 静默忽略 |\n| 跨动作 | 归一化后的键位相同 | 行内报错，阻止保存 |\n\n归一化只做三件事：小写、按固定顺序排列修饰键、把 `Cmd` 映射成 `Mod`。这样 `Shift+Cmd+K` 和 `Cmd+Shift+K` 才会被判成同一个键位。",
				},
			],
			"stop",
			[2_260, 236, 12_900, 0.0096],
		),
	],
});

const SESSIONS = [sidebarGroups, reviewPr, settingsKeys];

function tree() {
	return SESSIONS.map(item => ({
		entry: {
			type: "session",
			id: item.id,
			parentId: null,
			subagent: false,
			advisor: false,
			timestamp: iso(item.createdAt),
			updatedAt: iso(item.updatedAt),
			label: item.title,
		},
		children: [],
	}));
}

function list() {
	return SESSIONS.map(item => ({
		id: item.id,
		parentId: null,
		kind: "session",
		subagent: false,
		advisor: false,
		timestamp: iso(item.createdAt),
		updatedAt: iso(item.updatedAt),
		model: MODEL,
		messageCount: item.entries.length,
		cwd: CWD,
		modeId: item.modeId,
		paused: false,
		agentCount: 0,
		working: false,
		live: false,
		status: "complete",
		title: item.title,
	}));
}

function resume(sessionId) {
	const item = SESSIONS.find(candidate => candidate.id === sessionId);
	if (!item) {
		return {
			stream: null,
			snapshot: {
				entries: [],
				cursor: 0,
				state: { isStreaming: false, queuedMessageCount: 0, cwd: CWD, participants: [] },
			},
			compactedThrough: false,
		};
	}
	return {
		stream: null,
		snapshot: {
			header: {
				type: "session",
				id: item.id,
				timestamp: iso(item.createdAt),
				cwd: CWD,
				title: item.title,
				model: MODEL,
				modeId: item.modeId,
			},
			entries: item.entries,
			state: {
				isStreaming: false,
				queuedMessageCount: 0,
				cwd: CWD,
				participants: [],
				goalMode: null,
				planMode: false,
				todo: [],
				isCompacting: false,
				paused: false,
				pausedAt: null,
			},
			agents: [],
			cursor: item.entries.length,
			roundDurations: item.roundDurations,
			structureRev: 0,
			tail: { hasMore: false, beforeId: null },
		},
		compactedThrough: false,
	};
}

const CONTEXT = {
	"demo-sidebar-groups": { tokens: 128_400, contextWindow: 1_000_000, percent: 13 },
	"demo-review-pr128": { tokens: 42_600, contextWindow: 1_000_000, percent: 4 },
	"demo-settings-keys": { tokens: 18_900, contextWindow: 1_000_000, percent: 2 },
};

export const methods = {
	"session.tree": tree,
	"session.list": list,
	"session.resume": params => resume(params.sessionId),
	"session.pauseStatus": () => ({ paused: false, pausedAt: null }),
	"session.contextUsage": params => CONTEXT[params.sessionId] ?? null,
	"session.thinkingInfo": () => ({
		ceiling: "high",
		level: "medium",
		auto: false,
		resolved: null,
		efforts: ["minimal", "low", "medium", "high", "xhigh"],
		model: { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", provider: "anthropic" },
	}),
	"session.turns": params => {
		const item = SESSIONS.find(candidate => candidate.id === params.sessionId);
		const entries = item?.entries ?? [];
		const turns = entries.flatMap((entry, startIdx) => {
			if (entry.message?.role !== "user") return [];
			const text = typeof entry.message.content === "string" ? entry.message.content : "";
			return [
				{
					startIdx,
					entryId: entry.id,
					timestamp: entry.timestamp,
					summary: text.replace(/\s+/g, " ").trim().slice(0, 90),
					kind: "user",
				},
			];
		});
		return { turns, totalEntries: entries.length, hasMore: false, remaining: 0, nextBeforeTurn: null, stale: false };
	},
};

/** Session ids, so other fixtures can point at the same demo transcripts. */
export const sessions = SESSIONS.map(item => item.id);
