/**
 * 跨域 i18n 重复键门禁：词表 barrel 在模块加载时对重复键硬抛（整个 renderer bundle 加载
 * 失败 = 白屏），而 `bun run check` 的类型检查每域独立 satisfies，抓不到跨域重复——
 * 2026-09-29 白屏事故（"input tokens" 同时存在于 settings 与 general）即此盲区。
 *
 * 这里静态扫描每个语言 barrel 下所有域文件的顶层键，报告跨域交集并 exit 1。
 * 只扫键定义行（一tab缩进的 `key:` 或 `"key":`），不执行模块。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

/** 各语言 barrel：目录 + 运行时守卫所在的 index.ts（跳过）。 */
const BARRELS: { dir: string; label: string }[] = [
	{ dir: "packages/client-core/src/i18n/zh-CN", label: "client-core zh-CN" },
	{ dir: "packages/client-core/src/i18n/en-US", label: "client-core en-US" },
	{ dir: "packages/coding-agent/src/i18n/zh-CN", label: "coding-agent zh-CN (TUI)" },
];

const KEY_LINE = /^\t("[^"]+"|[A-Za-z_$][\w$]*)\s*:/;

function topLevelKeys(file: string): string[] {
	const keys: string[] = [];
	for (const line of readFileSync(file, "utf8").split("\n")) {
		const m = KEY_LINE.exec(line);
		if (m) keys.push(m[1].replace(/^"|"$/g, ""));
	}
	return keys;
}

let failed = false;
for (const barrel of BARRELS) {
	const dir = join(ROOT, barrel.dir);
	if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) continue;
	const seen = new Map<string, string>(); // key -> 首次出现的域文件
	const dups: string[] = [];
	for (const name of readdirSync(dir)) {
		if (!name.endsWith(".ts") || name === "index.ts") continue;
		const domain = name.replace(/\.ts$/, "");
		for (const key of topLevelKeys(join(dir, name))) {
			const prev = seen.get(key);
			if (prev) dups.push(`${key} (${prev} 与 ${domain})`);
			else seen.set(key, domain);
		}
	}
	if (dups.length > 0) {
		failed = true;
		console.error(`i18n 跨域重复键（${barrel.label}）：`);
		for (const d of dups) console.error(`  ${d}`);
	}
}
if (failed) process.exit(1);
console.log(`i18n dup-key ok (${BARRELS.length} 个语言 barrel 无跨域重复键)`);
