#!/usr/bin/env bun
/**
 * dev-smoke — 隔离冒烟运行器（铁律：验证/冒烟绝不写生产会话）。
 *
 * 用法：
 *   bun scripts/dev-smoke.ts bun run desktop
 *   bun scripts/dev-smoke.ts bun packages/coding-agent/src/cli.ts --help
 *   bun scripts/dev-smoke.ts --keep -- bun run desktop   # 保留临时目录用于排查
 *
 * （bun 会吞掉脚本路径后的第一个 `--`，所以 `--` 是可选的、只作分隔提示。）
 *
 * 隔离内容：
 *   - PI_CODING_AGENT_DIR → 临时目录（会话/记忆/统计全部落在这里，
 *     生产 ~/.musepi/agent/sessions 零写入）
 *   - MUSEPI_DAEMON_DIR   → 临时目录（daemon socket/journal 不与生桌面
 *     daemon 的 %TEMP%/musepi-daemon 冲突）
 *
 * 不隔离：config 根（~/.musepi 的 settings/profiles 等）。认证需要可用的
 * API key，因此默认把 ~/.musepi/agent/auth.json 复制进隔离目录（--no-auth
 * 关闭）。退出后默认清理临时目录（--keep 保留）。
 *
 * 为什么需要它：daemon 测试/手动冒烟若直接跑在仓库 cwd，会话文件会写入
 * 生产会话列表（"未命名会话"刷屏）；与生产 daemon 共用 socket 目录还会
 * 互相抢 journal。历史上这类残留曾在生产目录堆积 160+ 个测试会话。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const args = process.argv.slice(2);
const keep = args.includes("--keep");
const noAuth = args.includes("--no-auth");
// bun 会吞掉脚本路径后的第一个 `--`；若残留则忽略它。其余全部是要执行的命令。
const cmd = args.filter(a => a !== "--keep" && a !== "--no-auth" && a !== "--");

if (cmd.length === 0) {
	console.error("用法: bun scripts/dev-smoke.ts [--keep] [--no-auth] -- <command...>");
	process.exit(2);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "musepi-smoke-"));
const agentDir = path.join(root, "agent");
const daemonDir = path.join(root, "daemon");
fs.mkdirSync(agentDir, { recursive: true });
fs.mkdirSync(daemonDir, { recursive: true });

// 认证：冒烟通常需要真实 API key；复制（而非移动）并在退出时随目录销毁。
if (!noAuth) {
	const srcAuth = path.join(
		process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".musepi", "agent"),
		"auth.json",
	);
	if (fs.existsSync(srcAuth)) {
		fs.copyFileSync(srcAuth, path.join(agentDir, "auth.json"));
	} else {
		console.warn(`[dev-smoke] 未找到 auth.json（${srcAuth}），冒烟可能无法调用真实模型`);
	}
}

console.log(`[dev-smoke] 隔离目录: ${root}`);
console.log(`[dev-smoke] 会话将写入: ${path.join(agentDir, "sessions")}（生产零写入）`);

const child = Bun.spawn(cmd, {
	stdin: "inherit",
	stdout: "inherit",
	stderr: "inherit",
	env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, MUSEPI_DAEMON_DIR: daemonDir },
});

const exitCode = await child.exited;

if (keep) {
	console.log(`[dev-smoke] --keep：临时目录已保留，请手动删除: ${root}`);
} else {
	// 子进程句柄在 Windows 上可能有延迟释放，短重试后放弃（残留由 OS 清理）。
	// （不依赖 @musepi/pi-utils——scripts/ 不是包，模块解析不到工作区依赖。）
	let removed = false;
	for (let attempt = 0; attempt < 30 && !removed; attempt++) {
		try {
			fs.rmSync(root, { recursive: true, force: true });
			removed = !fs.existsSync(root);
		} catch {
			/* EBUSY/EPERM — retry */
		}
		if (!removed) Bun.sleepSync(100);
	}
	if (!removed) console.warn(`[dev-smoke] 临时目录删除失败（句柄未释放），请手动删除: ${root}`);
}

process.exit(exitCode);
