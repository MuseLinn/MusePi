// ============================================================
// memory — 启动注入块构建。
//
// 措辞原则照 OMP：记忆是启发式而非事实；与仓库现状冲突时以
// 仓库为准；引用记忆内容须附来源 artifact 路径。预算按节截断
// （项目 10k / 全局 6k token，chars/4 估算），空记忆不注入。
// ============================================================

import { memoryPaths } from "./paths.ts";
import { isEmptyMemory, readMemoryFile } from "./store.ts";

export interface MemoryCaps {
	/** 项目记忆注入预算（估算 token）。 */
	project: number;
	/** 全局记忆注入预算（估算 token）。 */
	global: number;
}

export const DEFAULT_MEMORY_CAPS: MemoryCaps = { project: 10_000, global: 6_000 };

/** 粗略 token 估算：chars/4（与 compaction 估算同量级精度，足够做预算）。 */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

const INJECTION_PREAMBLE = [
	"## Memory guidance",
	"The notes below are long-term memory carried over from previous sessions. They are",
	"heuristics, not facts: when memory conflicts with the current repository state, the",
	"repository wins — treat conflicting memory as stale. When memory influences your plan,",
	"cite the source artifact path shown with each section and pair it with current-repo",
	"evidence before acting.",
].join("\n");

/** 截断到 token 预算（按行截，避免切在半行）。 */
export function truncateToBudget(text: string, tokenCap: number): { text: string; truncated: boolean } {
	if (estimateTokens(text) <= tokenCap) return { text, truncated: false };
	const charCap = tokenCap * 4;
	const lines = text.split("\n");
	const kept: string[] = [];
	let total = 0;
	for (const line of lines) {
		if (total + line.length + 1 > charCap) break;
		kept.push(line);
		total += line.length + 1;
	}
	return {
		text: `${kept.join("\n")}\n[…memory truncated to fit the ${tokenCap}-token budget]`,
		truncated: true,
	};
}

export interface BuildInjectionOptions {
	dataDir: string;
	cwd: string;
	/** project = 只注入项目记忆；global = 项目 + 全局。 */
	scope: "project" | "global";
	caps?: MemoryCaps;
}

/**
 * 构建启动注入块。无实际记忆内容（骨架或空文件）时返回 null。
 */
export function buildMemoryInjection(options: BuildInjectionOptions): string | null {
	const caps = options.caps ?? DEFAULT_MEMORY_CAPS;
	const paths = memoryPaths(options.dataDir, options.cwd);
	const sections: string[] = [];

	const projectContent = readMemoryFile(paths.projectFile, "project");
	if (!isEmptyMemory(projectContent)) {
		const budgeted = truncateToBudget(projectContent, caps.project);
		sections.push(`### Project memory (${paths.projectFile})\n${budgeted.text}`);
	}

	if (options.scope === "global") {
		const globalContent = readMemoryFile(paths.globalFile, "global");
		if (!isEmptyMemory(globalContent)) {
			const budgeted = truncateToBudget(globalContent, caps.global);
			sections.push(`### Global memory (${paths.globalFile})\n${budgeted.text}`);
		}
	}

	if (sections.length === 0) return null;
	return `${INJECTION_PREAMBLE}\n\n${sections.join("\n\n")}`;
}
