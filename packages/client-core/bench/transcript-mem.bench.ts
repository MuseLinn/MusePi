/**
 * M1.11 transcript 虚拟化 mem-bench 基线实测。
 *
 * 背景(0.5.0 路线图 M1.11):当前 Transcript 是「全量挂载、hidden=0、无窗口截断」
 * (Transcript.tsx:80 注释明确记录了 WINDOW_INITIAL 截断已移除)。用户反馈:
 * 轮次多时侧边时间轴显示不全、向上滚动加载慢、恢复会话慢。本脚本对
 * 「全量派生(现状)」vs「尾部窗口派生(虚拟化目标形态)」做数据层实测,
 * 为是否引入虚拟滚动提供量化依据。
 *
 * 测量三层成本:
 *  A. 恢复成本 —— 全量 JSON 反序列化(会话 wire 载荷)
 *  B. 派生成本 —— entries 每次变更时 React useMemo 重算的纯函数
 *     (buildRoundFolds / buildTurnRenderUnits / hasPendingAsk / lastUserMessageTs)
 *  C. 内存占用 —— 派生结构 + 全量 entries 常驻的堆增量(heapUsed, Bun.gc 后)
 *
 * 对比形态:FULL(现状全量) vs WINDOW(尾部 W 条窗口,前缀以分页形式按需加载)。
 *
 * 运行: cd packages/client-core && bun run bench/transcript-mem.bench.ts
 */
import {
	buildRoundFolds,
	isInsideFold,
} from "../src/components/transcript/round-collapse";
import {
	buildTurnRenderUnits,
	hasPendingAsk,
} from "../src/components/transcript/render-units";
import { lastUserMessageTs } from "../src/components/transcript/transcript-content";
import type { SessionEntry } from "@musepi/pi-wire";

// ── 合成会话生成 ─────────────────────────────────────────────────────────────

let seq = 0;
const base = { parentId: null, timestamp: "0" };
function entry(overrides: object): SessionEntry {
	return { ...base, id: `e${++seq}`, ...overrides } as unknown as SessionEntry;
}

/** 可复现伪随机(避免每次运行数据不同导致数字漂移)。 */
function mulberry32(seed: number) {
	let a = seed;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}


function genText(rand: () => number, words: number): string {
	// 逐字符生成(而非共享 rope 切片),保证内存测量诚实 —— 真实会话的
	// 工具输出彼此独立,不会共享底层字符串存储。
	const target = Math.floor(words * 6);
	const pool = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 \n";
	let s = "";
	while (s.length < target) s += pool[Math.floor(rand() * pool.length)];
	return s;
}

/**
 * 一轮真实编码会话的近似形态:1 条用户消息 + 1 条 assistant 文本
 * + 4~8 组 toolCall/toolResult(bash/read 输出按 2~20KB 分布)。
 */
function genRound(rand: () => number): SessionEntry[] {
	const out: SessionEntry[] = [];
	const tools = 4 + Math.floor(rand() * 5);
	out.push(
		entry({
			type: "message",
			message: { role: "user", content: genText(rand, 20 + Math.floor(rand() * 300)), timestamp: 1 },
		}),
	);
	for (let i = 0; i < tools; i++) {
		const callId = `c${seq + 1}`;
		const name = ["read", "bash", "grep", "edit"][Math.floor(rand() * 4)];
		out.push(
			entry({
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: callId, name, arguments: { path: `src/f${i}.ts` } }],
					timestamp: 1,
				},
			}),
		);
		const outSize = 300 + Math.floor(rand() * 20000);
		out.push(
			entry({
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: callId,
					toolName: name,
					content: [{ type: "text", text: genText(rand, outSize / 6) }],
					isError: rand() < 0.05,
					timestamp: 1,
				},
			}),
		);
	}
	out.push(
		entry({
			type: "message",
			message: {
				role: "assistant",
				content: [{ type: "text", text: genText(rand, 80 + Math.floor(rand() * 400)) }],
				timestamp: 1,
			},
		}),
	);
	return out;
}

function genSession(rounds: number, seed = 42): SessionEntry[] {
	const rand = mulberry32(seed);
	const all: SessionEntry[] = [];
	for (let r = 0; r < rounds; r++) all.push(...genRound(rand));
	return all;
}

// ── 测量工具 ─────────────────────────────────────────────────────────────────

function median(xs: number[]): number {
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.floor(s.length / 2)]!;
}

function timeRuns(label: string, runs: number, fn: () => void): number {
	// 预热
	fn();
	const samples: number[] = [];
	for (let i = 0; i < runs; i++) {
		const t0 = performance.now();
		fn();
		samples.push(performance.now() - t0);
	}
	return median(samples);
}

/** 现状派生集合(Transcript.tsx 中依赖 entries 的 useMemo 链的同构子集)。 */
function derive(entries: readonly SessionEntry[]) {
	const folds = buildRoundFolds(entries, false);
	const units = buildTurnRenderUnits(entries, false);
	const pending = hasPendingAsk(entries);
	const lastTs = lastUserMessageTs(entries);
	let foldedRows = 0;
	for (let i = 0; i < entries.length; i++) if (isInsideFold(folds, i)) foldedRows++;
	return { folds, units, pending, lastTs, foldedRows };
}

interface Row {
	rounds: number;
	entries: number;
	wireMB: number;
	restoreMs: number;
	deriveFullMs: number;
	deriveWindowMs: number;
	heapFullMB: number;
	heapWindowMB: number;
	windowEntries: number;
}

const WINDOW_SIZE = 300; // 虚拟化目标形态:尾部窗口条目数

function benchSize(rounds: number): Row {
	const entries = genSession(rounds);
	const windowed = entries.slice(-WINDOW_SIZE);

	// A. 恢复成本:全量 wire 载荷反序列化
	const wire = JSON.stringify(entries);
	const wireMB = wire.length / 1024 / 1024;
	const restoreMs = timeRuns("restore", 5, () => {
		JSON.parse(wire);
	});

	// B. 派生成本
	const deriveFullMs = timeRuns("derive-full", 7, () => {
		derive(entries);
	});
	const deriveWindowMs = timeRuns("derive-window", 7, () => {
		derive(windowed);
	});

	// C. 常驻数据量估计:遍历 entries 统计全部字符串字节数(JSC 的 rss
	// 受 GC 页归还影响波动过大,实测 ±400MB 噪声,不可用;字符串总量是
	// 稳定的内存压力代理 —— JS 中字符串 ≈ 2B/char UTF-16 + 对象头)。
	const dataBytes = (list: readonly SessionEntry[]) => {
		let n = 0;
		const walk = (v: unknown) => {
			if (typeof v === "string") n += v.length * 2;
			else if (Array.isArray(v)) for (const x of v) walk(x);
			else if (v && typeof v === "object") for (const x of Object.values(v)) walk(x);
		};
		for (const e of list) walk(e);
		return n / 1024 / 1024;
	};
	const heapFullMB = dataBytes(entries);
	const heapWindowMB = dataBytes(windowed);

	return {
		rounds,
		entries: entries.length,
		wireMB,
		restoreMs,
		deriveFullMs,
		deriveWindowMs,
		heapFullMB,
		heapWindowMB,
		windowEntries: windowed.length,
	};
}


// ── 主流程 ───────────────────────────────────────────────────────────────────

const SIZES = [300, 1000, 3000];
const rows: Row[] = [];
for (const rounds of SIZES) {
	rows.push(benchSize(rounds));
	console.log(`bench rounds=${rounds} done`);
}

const fmt = (n: number, digits = 1) => n.toFixed(digits);
console.log("\n═══ M1.11 transcript mem-bench 基线 ═══\n");
console.log("| 轮次 | 条目数 | wire 载荷 | 恢复(parse) | 派生-全量 | 派生-窗口 | 数据量-全量 | 数据量-窗口 |");
console.log("|---|---|---|---|---|---|---|---|");
for (const r of rows) {
	console.log(
		`| ${r.rounds} | ${r.entries} | ${fmt(r.wireMB, 2)} MB | ${fmt(r.restoreMs)} ms | ${fmt(r.deriveFullMs)} ms | ${fmt(r.deriveWindowMs)} ms | ${fmt(r.heapFullMB, 3)} MB | ${fmt(r.heapWindowMB, 3)} MB |`,
	);
}
console.log("\n注:派生列为中位数;窗口形态 = 尾部 300 条 + 前缀分页按需加载。");
console.log("窗口条目数固定,故窗口列不随轮次增长 —— 这正是虚拟化的收益曲线。");
