/**
 * 能力缝声明（索引：docs/capability-seams.md「第三方 Cordis 插件适配」）：
 * - 名称+ns：`modern-web-guidance` Cordis 插件、`modern_web_guidance` 工具与同名虚拟技能。
 * - 输入：search/retrieve/list operation、query、skillVersion；包内技能与 CLI 或上游 npx。
 * - 输出：注册技能内容、上游指南文本、非零退出与截断状态。
 * - 生命周期：安装缓存生成入口；mount 注册，detach 移除；升级重新生成适配文件。
 * - 启停：遵循 MarketplaceManager 与 Cordis fiber；禁用不保留工具或技能。
 * - 冲突：独占 `modern_web_guidance` 工具；不改上游源目录，不执行安装脚本。
 * - 检视入口：`src/extensibility/plugins/compat/modern-web-guidance-adapter.ts`、`docs/extensions-dev.md`。
 */
import { readFileSync } from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "../../extensions/types";

const MAX_OUTPUT_CHARS = 256 * 1024;
const OUTPUT_MARKER = "\n[output truncated]";
const PROCESS_TIMEOUT_MS = 60_000;

interface ModernWebGuidanceInput {
	operation: "search" | "retrieve" | "list";
	query?: string;
	skillVersion?: string;
}

const parameters = {
	"~standard": {
		version: 1 as const,
		vendor: "musepi",
		validate(value: unknown) {
			if (!value || typeof value !== "object") return { issues: [{ message: "parameters must be an object" }] };
			const input = value as Record<string, unknown>;
			if (input.operation !== "search" && input.operation !== "retrieve" && input.operation !== "list") {
				return { issues: [{ message: "operation must be search, retrieve, or list" }] };
			}
			if (input.operation !== "list" && typeof input.query !== "string") {
				return { issues: [{ message: `${input.operation} requires a query` }] };
			}
			if (input.skillVersion !== undefined && typeof input.skillVersion !== "string") {
				return { issues: [{ message: "skillVersion must be a string" }] };
			}
			return { value };
		},
	},
};

export default function apply(pi: ExtensionAPI): void {
	pi.setLabel("Modern Web Guidance");
	const pluginRoot = path.resolve(import.meta.dir, "..");
	try {
		const content = readFileSync(path.join(pluginRoot, "skills", "modern-web-guidance", "SKILL.md"), "utf8");
		const body = content.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
		pi.registerSkill({
			name: "modern-web-guidance",
			description: "Modern Web development best practices",
			content: `${body}\n\n## Cordis tool mapping\nUse the registered modern_web_guidance tool for search, retrieve, and list operations. It runs the CLI version pinned by this installation.`,
		});
	} catch {
		// A package without its skill resource keeps the tool but has no virtual skill.
	}

	pi.registerTool({
		name: "modern_web_guidance",
		label: "Modern Web Guidance",
		description: "Search and retrieve modern Web development guidance",
		parameters,
		async execute(_toolCallId: string, input: ModernWebGuidanceInput, signal?: AbortSignal) {
			if (input.operation !== "search" && input.operation !== "retrieve" && input.operation !== "list") {
				throw new Error(`Unsupported operation: ${input.operation}`);
			}
			if (input.operation !== "list" && !input.query) throw new Error(`${input.operation} requires a query`);
			if (signal?.aborted) throw new Error("modern-web-guidance aborted");
			const args: string[] = [input.operation];
			if (input.query) args.push(input.query);
			if (input.skillVersion) args.push("--skill-version", input.skillVersion);
			const cliPath = path.join(pluginRoot, "skills", "modern-web-guidance", "modern-web.mjs");
			const packaged = await Bun.file(cliPath).exists();
			const executable = packaged ? process.execPath : process.platform === "win32" ? "npx.cmd" : "npx";
			const pkg = (await Bun.file(path.join(pluginRoot, "package.json")).json()) as { version?: unknown };
			const version = typeof pkg.version === "string" && pkg.version.length > 0 ? pkg.version : "0.0.0";
			const command = packaged ? [cliPath, ...args] : ["-y", `modern-web-guidance@${version}`, ...args];
			const child = Bun.spawn([executable, ...command], {
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
				windowsHide: true,
			});
			const onAbort = () => child.kill();
			signal?.addEventListener("abort", onAbort, { once: true });
			if (signal?.aborted) onAbort();
			const timeout = setTimeout(onAbort, PROCESS_TIMEOUT_MS);
			try {
				const [exitCode, stdout, stderr] = await Promise.all([
					child.exited,
					readCapped(child.stdout, child),
					readCapped(child.stderr, child),
				]);
				if (signal?.aborted) throw new Error("modern-web-guidance aborted");
				if (exitCode !== 0) {
					throw new Error(`modern-web-guidance exited with code ${exitCode}: ${stderr || stdout}`);
				}
				return { content: [{ type: "text", text: stdout + (stderr ? `\n${stderr}` : "") }] };
			} finally {
				clearTimeout(timeout);
				signal?.removeEventListener("abort", onAbort);
			}
		},
	});
}

async function readCapped(stream: ReadableStream<Uint8Array> | null, child: { kill(): void }): Promise<string> {
	if (!stream) return "";
	const decoder = new TextDecoder();
	let text = "";
	for await (const chunk of stream) {
		text += decoder.decode(chunk, { stream: true });
		if (text.length + OUTPUT_MARKER.length >= MAX_OUTPUT_CHARS) {
			child.kill();
			return `${text.slice(0, MAX_OUTPUT_CHARS - OUTPUT_MARKER.length)}${OUTPUT_MARKER}`;
		}
	}
	return text;
}
