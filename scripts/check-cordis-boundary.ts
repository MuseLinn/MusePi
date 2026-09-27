/**
 * cordis 收编边界门禁（ADR 0001）：核心领域包不得 import cordis。
 *
 * cordis 只允许出现在 daemon 宿主层（packages/coding-agent/src/daemon/）
 * 与未来新增的宿主侧包；领域包消费的是纯 TS 服务接口，不感知组合内核。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const GUARDED_PACKAGES = ["agent", "ai", "wire", "sdk", "catalog"];
const ROOT = join(import.meta.dir, "..");

function* walk(dir: string): Generator<string> {
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) {
			if (name === "node_modules" || name === "dist") continue;
			yield* walk(p);
		} else if (/\.(ts|tsx|mts|cts)$/.test(name)) {
			yield p;
		}
	}
}

const offenders: string[] = [];
for (const pkg of GUARDED_PACKAGES) {
	const dir = join(ROOT, "packages", pkg);
	try {
		statSync(dir);
	} catch {
		continue; // 包不存在（如 wire）不阻塞
	}
	for (const file of walk(dir)) {
		const src = readFileSync(file, "utf8");
		if (/from\s+["'][^"']*cordis|import\s*\(\s*["'][^"']*cordis/.test(src)) {
			offenders.push(file);
		}
	}
}

if (offenders.length > 0) {
	console.error("cordis import 越界（ADR 0001：核心领域包零 cordis 依赖）：");
	for (const f of offenders) console.error(`  ${f}`);
	process.exit(1);
}
console.log(`cordis boundary ok (${GUARDED_PACKAGES.length} 个领域包无 cordis import)`);
