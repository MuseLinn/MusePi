/**
 * 能力缝声明（索引：docs/capability-seams.md「外部产品子智能体」）：
 * - 名称+ns：五个实验性外部产品插件的 `probeExecutable` 扩展 RPC。
 * - 输入：可选可执行文件路径、产品 PATH 查找名与调用方工作目录。
 * - 输出：解析路径与版本，或 not-found/failed 和有界诊断；不验证模型或凭据。
 * - 生命周期：配置页打开、路径失焦或手动重检时一次性执行，加载插件不启动产品。
 * - 启停：随所属 Cordis 插件注册与卸载，禁用后 RPC 不可调用。
 * - 冲突：各插件在自己的 RPC 命名空间注册同名方法，不共享进程或全局状态。
 * - 检视入口：`src/task/external-executable-probe.ts`、`docs/gui-implementation.md`。
 */
import { $which, WhichCachePolicy } from "@musepi/pi-utils";
import type { ExtensionAPI } from "../extensibility/extensions/types";

const PROBE_TIMEOUT_MS = 5_000;
const MAX_DIAGNOSTIC_CHARS = 400;

export type ExternalExecutableProbeResult =
	| { available: true; path: string; version: string }
	| { available: false; reason: "not-found" | "failed"; path?: string; error?: string };

export interface ExternalExecutableProbeDependencies {
	which: typeof $which;
	run(executable: string, cwd: string): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

async function runVersionProbe(executable: string, cwd: string) {
	const child = Bun.spawn([executable, "--version"], {
		cwd,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		windowsHide: true,
	});
	const timeout = setTimeout(() => child.kill(), PROBE_TIMEOUT_MS);
	try {
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		return { exitCode, stdout, stderr };
	} finally {
		clearTimeout(timeout);
	}
}

function diagnostic(value: string): string {
	return value.trim().slice(0, MAX_DIAGNOSTIC_CHARS);
}

export async function probeExternalExecutable(
	executable: string | undefined,
	fallback: string,
	cwd: string,
	dependencies: ExternalExecutableProbeDependencies = { which: $which, run: runVersionProbe },
): Promise<ExternalExecutableProbeResult> {
	const requested = executable?.trim() || fallback;
	const resolved = dependencies.which(requested, { cwd, cache: WhichCachePolicy.Fresh });
	if (!resolved) return { available: false, reason: "not-found", path: undefined };
	try {
		const { exitCode, stdout, stderr } = await dependencies.run(resolved, cwd);
		if (exitCode !== 0) {
			const detail = diagnostic(stderr || stdout);
			return {
				available: false,
				reason: "failed",
				path: resolved,
				error: `${requested} --version exited with code ${exitCode}${detail ? `: ${detail}` : ""}`,
			};
		}
		return { available: true, path: resolved, version: diagnostic(stdout || stderr).split("\n")[0] ?? "" };
	} catch (error) {
		return {
			available: false,
			reason: "failed",
			path: resolved,
			error: diagnostic(error instanceof Error ? error.message : String(error)),
		};
	}
}

export function registerExternalExecutableProbe(pi: ExtensionAPI, fallback: string): void {
	pi.registerRpc("probeExecutable", (value, ctx) => {
		const input = value && typeof value === "object" ? (value as { executable?: unknown }).executable : undefined;
		return probeExternalExecutable(typeof input === "string" ? input : undefined, fallback, ctx.cwd);
	});
}
