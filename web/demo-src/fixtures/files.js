/**
 * File-workspace fixtures: the virtual project the demo's file view browses.
 *
 * The pane asks for a flat `workspace.tree` (paths relative to the session
 * cwd) and opens files through `fs.readBytes` (base64 + mime). Both shapes are
 * copied from a real daemon, so the real FilePane, its viewer registry and the
 * Markdown renderer run unchanged over demo bytes.
 */

const ROOT = "/home/musepi/Projects/atlas";
const NOW = 1_793_000_000_000;

const DIRECTORIES = ["docs", "src"];

const FILES = new Map([
	[
		"README.md",
		{
			mtime: NOW - 40 * 60_000,
			content: `# 星轨手账

记录每次观星计划的小工具：挑目标、估算可见窗口，再把它们写进当晚的清单。

## 快速开始

\`\`\`bash
bun install
bun run dev
\`\`\`

## 目录

| 路径 | 说明 |
| --- | --- |
| \`src/app.ts\` | 命令行入口：读取星表并排期 |
| \`src/schedule.ts\` | 可见窗口计算与排序 |
| \`docs/notes.md\` | 设计笔记与取舍记录 |
| \`package.json\` | 脚本与依赖 |

> 这里的文件来自演示 daemon 的内存，不会读写你的磁盘。
`,
		},
	],
	[
		"package.json",
		{
			mtime: NOW - 90 * 60_000,
			content: `{
	"name": "orbit-notes",
	"private": true,
	"type": "module",
	"scripts": {
		"dev": "bun run src/app.ts",
		"test": "bun test"
	}
}
`,
		},
	],
	[
		"src/app.ts",
		{
			mtime: NOW - 12 * 60_000,
			content: `import { schedule } from "./schedule";

interface Target {
	name: string;
	ra: number;
	dec: number;
}

const targets: Target[] = [
	{ name: "M31", ra: 0.712, dec: 41.27 },
	{ name: "M42", ra: 5.588, dec: -5.39 },
	{ name: "M13", ra: 16.695, dec: 36.46 },
];

const tonight = schedule(targets, { start: "20:30", end: "23:45" });

for (const slot of tonight) {
	console.log(\`\${slot.start}  \${slot.target.name}  \${slot.altitude}°\`);
}
`,
		},
	],
	[
		"src/schedule.ts",
		{
			mtime: NOW - 26 * 60_000,
			content: `interface Target {
	name: string;
	ra: number;
	dec: number;
}

interface Slot {
	start: string;
	target: Target;
	altitude: number;
}

/** Upper culmination at 20:30 local: a target is visible while its hour angle
 *  stays inside ±2h and it clears the 20° haze band. */
const MIN_ALTITUDE = 20;
const WINDOW_MINUTES = 240;

function altitudeAt(target: Target, minutes: number): number {
	const hourAngle = (minutes / 60 - (target.ra * 15 + 20.5)) % 24;
	const folded = Math.abs(hourAngle) > 12 ? 24 - Math.abs(hourAngle) : Math.abs(hourAngle);
	return 90 - Math.abs(target.dec) - folded * 15;
}

export function schedule(targets: Target[], night: { start: string; end: string }): Slot[] {
	const [startH, startM] = night.start.split(":").map(Number);
	const [endH, endM] = night.end.split(":").map(Number);
	const from = startH * 60 + startM;
	const to = endH * 60 + endM;

	return targets
		.map(target => {
			const minutes = from + WINDOW_MINUTES / 2;
			return { target, minutes, altitude: Math.round(altitudeAt(target, minutes)) };
		})
		.filter(slot => slot.altitude >= MIN_ALTITUDE && slot.minutes <= to)
		.sort((a, b) => b.altitude - a.altitude)
		.map(slot => ({
			start: \`\${String(Math.floor(slot.minutes / 60)).padStart(2, "0")}:\${String(slot.minutes % 60).padStart(2, "0")}\`,
			target: slot.target,
			altitude: slot.altitude,
		}));
}
`,
		},
	],
	[
		"docs/notes.md",
		{
			mtime: NOW - 3 * 60 * 60_000,
			content: `# 设计笔记

## 为什么先做排期，而不是星图

排期只需要赤经赤纬和观测地坐标，一小时就能算完；星图要渲染、要缩放、
要对齐星等，投入大得多。先用排期验证「今晚看什么」这个真问题。

## 取舍

- 目标数量上限 20 个：再多一个晚上也看不完。
- 高度角低于 20° 直接跳过，大气抖动太大。
- 不做自动寻星，只输出时间与方位角，剩下的交给赤道仪。
`,
		},
	],
]);

const MIME = {
	md: "text/markdown",
	json: "application/json",
	ts: "text/plain",
};

function mimeOf(path) {
	const dot = path.lastIndexOf(".");
	return dot === -1 ? "application/octet-stream" : (MIME[path.slice(dot + 1)] ?? "application/octet-stream");
}

/** Path inside the virtual project → its project-relative form, or null. */
function relativeOf(path) {
	const normalized = String(path ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
	if (normalized === ROOT) return "";
	if (!normalized.startsWith(`${ROOT}/`)) return null;
	return normalized.slice(ROOT.length + 1);
}

function bytesOf(text) {
	return new TextEncoder().encode(text);
}

function base64(bytes) {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

function entries() {
	const list = [
		...DIRECTORIES.map(path => ({ path, isDir: true, size: 0, mtime: NOW - 2 * 60 * 60_000 })),
		...[...FILES].map(([path, file]) => ({ path, isDir: false, size: bytesOf(file.content).length, mtime: file.mtime })),
	];
	return list.map(entry => ({
		name: entry.path.slice(entry.path.lastIndexOf("/") + 1),
		path: entry.path,
		isDir: entry.isDir,
		isSymlink: false,
		size: entry.size,
		mtime: entry.mtime,
		depth: entry.path.split("/").length,
	}));
}

const WORKSPACE = {
	id: "ws_demo_project",
	root: ROOT,
	name: "星轨手账",
	kind: "managed",
	additionalDirs: [],
	createdAt: NOW - 30 * 24 * 60 * 60_000,
	lastOpenedAt: NOW,
};

export const methods = {
	"workspace.list": () => ({ workspaces: [WORKSPACE] }),

	// A `root` narrows the scan to a subdirectory while entry paths stay
	// cwd-relative, exactly as the daemon re-roots them.
	"workspace.tree": params => {
		const subRoot = String(params.root ?? "").replace(/^\/+|\/+$/g, "");
		const depthLimit = (subRoot === "" ? 0 : subRoot.split("/").length) + (params.maxDepth ?? 2);
		const scoped = entries().filter(entry => subRoot === "" || entry.path.startsWith(`${subRoot}/`));
		return {
			rootPath: ROOT,
			truncated: false,
			entries: scoped
				.filter(entry => entry.depth <= depthLimit)
				.sort((a, b) => a.path.localeCompare(b.path)),
		};
	},

	"fs.readBytes": params => {
		const file = FILES.get(relativeOf(params.path) ?? "");
		if (!file) return { error: `ENOENT: no such file or directory, stat '${params.path}'` };
		const bytes = bytesOf(file.content);
		return { base64: base64(bytes), size: bytes.length, mime: mimeOf(params.path) };
	},

	"fs.read": params => ({ content: FILES.get(relativeOf(params.path) ?? "")?.content ?? null }),

	"fs.stat": params => {
		const relative = relativeOf(params.path);
		const isDirectory = relative === "" || DIRECTORIES.includes(relative);
		return { exists: isDirectory || FILES.has(relative ?? ""), isDirectory };
	},

	"git.status": () => ({ root: ROOT, branch: "main", ahead: 0, behind: 0, staged: [], unstaged: [] }),
	"git.branches": () => ({ current: "main", branches: ["main", "demo"] }),
	"git.identity": () => ({ name: "MusePi Demo", email: "demo@musepi.example", source: "global" }),
};
