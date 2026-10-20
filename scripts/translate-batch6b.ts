/**
 * Batch 6 completion: the domain-ownership fix removed entries my repair put
 * into the wrong domain file (they already lived in selector/errors/mcp/setup).
 * But the removal took out entries the SCHEMA lookup still needs under EN-text
 * keys. The schema's runtime contract is: t(EN-text) must resolve in the
 * dictionary file the settings domain reads. Re-add exactly the EN-text keys
 * that are missing after the ownership cleanup, as identity (brand) or with
 * the batch translation.
 */
import { applyBatch } from "./schema-batch-apply.ts";

const TRANSLATIONS: Record<string, string> = {
	// Brands / tech — identity in both dictionaries.
	"AGENTS.md": "AGENTS.md", "AI": "AI", "APFS": "APFS", "Anthropic": "Anthropic",
	"Bash": "Bash", "Claude Code": "Claude Code", "DeepSeek": "DeepSeek", "Exa": "Exa",
	"GLM": "GLM", "Gemini": "Gemini", "Gemma": "Gemma", "GitHub CLI": "GitHub CLI",
	"GitHub Gist": "GitHub Gist", "Harmony": "Harmony", "Hermes": "Hermes",
	"Hindsight": "Hindsight", "Jina": "Jina", "Kimi": "Kimi", "LSP": "LSP", "Lynx": "Lynx",
	"MiniMax": "MiniMax", "Mnemopi": "Mnemopi", "OpenAI": "OpenAI", "Pi": "Pi",
	"Powerline": "Powerline", "Qwen3": "Qwen3", "Shell": "Shell", "TTSR": "TTSR",
	"Top K": "Top K", "Top P": "Top P", "Trafilatura": "Trafilatura", "XML": "XML",
	"Yolo": "Yolo", "ZFS": "ZFS", "api.kimi.com": "api.kimi.com",
	"api.moonshot.ai": "api.moonshot.ai", "btrfs": "btrfs", "ASCII": "ASCII",
	"ZFS snapshot + clone": "ZFS 快照 + 克隆",
	"btrfs subvolume snapshot": "btrfs 子卷快照",
	"Linux FICLONE per-file reflink": "Linux FICLONE 逐文件 reflink",
	"Windows FSCTL_DUPLICATE_EXTENTS_TO_FILE (NTFS/ReFS)": "Windows FSCTL_DUPLICATE_EXTENTS_TO_FILE（NTFS/ReFS）",
	"Windows Projected File System": "Windows Projected File System（ProjFS）",
	"macOS clonefile reflink (APFS)": "macOS clonefile reflink（APFS）",
	"OpenAI WebSockets": "OpenAI WebSocket",
	"Silver 16, CJK": "Silver 16, CJK",
	"简体中文": "简体中文", "使用中文界面": "使用中文界面",
	":exacto": ":exacto（精准）", ":floor": ":floor（下限）",
	":nitro": ":nitro（极速）", ":online": ":online（在线）",
	// Option labels.
	"All": "全部", "Ask": "询问", "No": "否", "Yes": "是", "Debug": "调试",
	"Double": "双倍", "Triple": "三倍", "Instant": "即时", "Lenient": "宽松",
	"Local": "本地", "Model": "模型", "Moderate": "适中", "Native": "原生",
	"No isolation": "无隔离", "No limit": "不限制", "Notify": "通知", "Parallel": "并行",
	"Preferred": "优先", "Priority": "优先级", "Production Only": "仅生产环境",
	"Reset": "重置", "Sandbox Only": "仅沙箱", "Single": "单份", "Smart": "智能",
	"Standard": "标准", "Unlimited": "不限", "Unset": "未设置", "Write": "写入",
	"Glob": "文件通配", "Grep": "内容搜索", "Patch": "补丁",
	"Overlayfs": "Overlayfs 覆盖层", "ProjFS": "ProjFS 提供程序", "Reflink": "Reflink 硬链接",
	"Codex Reset Fireworks": "Codex 重置烟花", "Large context window": "大上下文窗口",
	"Last turn": "最后一轮",
	"Hindsight API Token": "Hindsight API 令牌",
	"Hindsight API URL": "Hindsight API 地址",
	"Mnemopi LLM Base URL": "Mnemopi LLM 基础地址",
	"Web UI URL": "Web 界面地址",
	// Prose.
	"Ask the official registry first, then try the public mirror if the failure is one it could answer":
		"先问官方仓库，失败属于其可答类型时再试公共镜像",
	"Registry URL used when the install source is set to Custom. Takes effect on the next plugin install.":
		"安装来源设为「自定义」时使用的仓库地址。下次安装插件时生效。",
	"Isolation backend for subagents. \"auto\" lets the native PAL pick the best available backend (CoW-aware filesystems, then overlayfs/ProjFS, then a git worktree / recursive-copy fallback).":
		"子代理的隔离后端。auto 由原生 PAL 自动选择最佳可用后端（先 CoW 感知的文件系统，再 overlayfs/ProjFS，最后回退 git worktree / 递归复制）。",
	"Maximum concurrent LLM requests per provider id (for example \"openai\" or \"anthropic\"), shared across local OMP processes with this config root. Omitted providers are unlimited.":
		"每个供应商 id 的最大并发 LLM 请求数（如 \"openai\"、\"anthropic\"），同一配置根下的本地 OMP 进程共享。未列出的供应商不限。",
	"Processing tier for Claude requests. `priority` realizes fast mode (`speed: \"fast\"`) on supported direct Anthropic models; ignored on Bedrock/Vertex Claude and via OpenRouter.":
		"Claude 请求的处理档位。priority 在受支持的 Anthropic 直连模型上实现 fast 模式（speed: \"fast\"）；Bedrock/Vertex Claude 与 OpenRouter 忽略。",
	"Serving path for Fireworks requests. Priority sends `service_tier: \"priority\"` for higher reliability during peak traffic at a higher price; Standard omits it. Fast (`-fast`) models ignore this — Fast is its own serving path.":
		"Fireworks 请求的服务路径。Priority 发送 service_tier: \"priority\"，高峰期可靠性更高、价格更贵；Standard 不发送。Fast（-fast）模型忽略此项——Fast 本身就是独立服务路径。",
	"JSON object mapping model roles, model selectors (\"provider/model-id\"), or provider wildcards (\"provider/*\") to ordered fallback selectors, e.g. {\"default\":[\"openai/gpt-4o-mini\"],\"google-antigravity/*\":[\"google/*\",\"google-vertex/*\"]}. Model-oriented keys apply whenever that model/provider is active, regardless of role; a \"provider/*\" entry keeps the failing model's id and swaps the provider. An id-prefixed wildcard (\"openrouter/google/*\") re-prefixes the failing model's bare id (google-antigravity/gemini-x -> openrouter/google/gemini-x) and, used as a key, matches only that provider's ids under the prefix.":
		"JSON 对象：把模型角色、模型选择器（\"provider/model-id\"）或供应商通配（\"provider/*\"）映射到有序回退选择器，如 {\"default\":[\"openai/gpt-4o-mini\"],\"google-antigravity/*\":[\"google/*\",\"google-vertex/*\"]}。面向模型的键在该模型/供应商活跃时生效、与角色无关；\"provider/*\" 条目保留失败模型的 id、只换供应商。带 id 前缀的通配（\"openrouter/google/*\"）会给失败模型的裸 id 重新加前缀（google-antigravity/gemini-x → openrouter/google/gemini-x），作为键时只匹配该前缀下此供应商的 id。",
	"While the computer tool operates the host desktop, show a full-screen glow edge, status badge, and per-action target highlight on your displays so you always see what the agent is doing":
		"计算机工具操控桌面时，在显示器上显示全屏辉光边缘、状态徽标与逐步操作的目标高亮，代理在做什么始终可见",
};

applyBatch(TRANSLATIONS, process.argv.includes("--apply"));
