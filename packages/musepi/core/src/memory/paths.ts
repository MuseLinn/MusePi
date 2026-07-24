// ============================================================
// memory — 路径与项目标识（MiMo-Code 同款约定）。
//
// pid = 仓库绝对路径 sha256 的前 12 hex：跨机器不稳定（绝对路径
// 参与哈希），但同机同仓库恒定——这正是项目隔离的键。
// 目录布局（dataDir 由 host 注入，core 不解析 ~）：
//   <dataDir>/memory/global/MEMORY.md
//   <dataDir>/memory/projects/<pid>/MEMORY.md
// ============================================================

import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

/** MiMo-style project id: first 12 hex chars of sha256(absolute cwd). */
export function computeProjectId(cwd: string): string {
	const absolute = resolve(cwd);
	return createHash("sha256").update(absolute).digest("hex").slice(0, 12);
}

export interface MemoryPaths {
	/** <dataDir>/memory */
	root: string;
	/** <dataDir>/memory/global/MEMORY.md */
	globalFile: string;
	/** <dataDir>/memory/projects/<pid>/MEMORY.md */
	projectFile: string;
	projectId: string;
}

export function memoryPaths(dataDir: string, cwd: string): MemoryPaths {
	const projectId = computeProjectId(cwd);
	const root = join(dataDir, "memory");
	return {
		root,
		globalFile: join(root, "global", "MEMORY.md"),
		projectFile: join(root, "projects", projectId, "MEMORY.md"),
		projectId,
	};
}
