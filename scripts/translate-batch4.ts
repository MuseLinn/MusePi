/**
 * Batch 4: the settings schema's remaining strings — brand entries (identity
 * values so both dictionaries carry them and the gate passes), the short
 * option labels, and the long prose descriptions (part 1 of 2).
 */
import { applyBatch } from "./schema-batch-apply.ts";

const TRANSLATIONS: Record<string, string> = {
	// ── Brands / tech names — identity values, both dictionaries ──────
	"AI": "AI",
	"Pi": "Pi",
	"Gemini": "Gemini",
	"Hermes": "Hermes",
	"OpenAI": "OpenAI",
	"Harmony": "Harmony",
	"MiniMax": "MiniMax",
	"DeepSeek": "DeepSeek",
	"AGENTS.md": "AGENTS.md",
	"Anthropic": "Anthropic",
	"Powerline": "Powerline",
	"GitHub CLI": "GitHub CLI",
	"Claude Code": "Claude Code",
	"GitHub Gist": "GitHub Gist",
	"Trafilatura": "Trafilatura",
	"Bash": "Bash",
	"Exa": "Exa",
	"GLM": "GLM",
	"XML": "XML",
	"ZFS": "ZFS",
	"APFS": "APFS",
	"btrfs": "btrfs",
	"Kimi": "Kimi",
	"Jina": "Jina",
	"Lynx": "Lynx",
	"TTSR": "TTSR",
	"Yolo": "Yolo",
	"Gemma": "Gemma",
	"Qwen3": "Qwen3",
	"Shell": "Shell",
	"Top K": "Top K",
	"Top P": "Top P",
	"Silver 16, CJK": "Silver 16, CJK",
	"api.kimi.com": "api.kimi.com",
	"api.moonshot.ai": "api.moonshot.ai",

	// ── Short labels ───────────────────────────────────────────────────
	"简体中文": "简体中文",
	"使用中文界面": "使用中文界面",
	":floor": ":floor（下限）",
	":nitro": ":nitro（极速）",
	":exacto": ":exacto（精准）",
	":online": ":online（在线）",
	"Read content": "读取内容",
	"Enable the Exa web search provider": "启用 Exa 网络搜索供应商",
	"Always use the URL configured below": "始终使用下方配置的地址",

	// ── Prose: short-to-medium descriptions ────────────────────────────
	"user@host destination for the ssh reverse forward": "ssh 反向转发的 user@host 目标",
	"Single top rule with status docked onto it and below": "单条顶线，状态停靠在线上及线下",
	"Status line embedded in top border, compact 2-line prompt": "状态线内嵌顶边框，紧凑两行提示符",
	"Mechanical + small-model classification of text-only stops": "机械规则 + 小模型对纯文本停更的分类",
	"Replay the transcript at the new width below retained history": "按新宽度重放对话，保留的历史保持原换行",
	"Just under the 200K tier break some providers bill double past": "部分供应商在 200K 档位之上按双倍计费",
	"Update channel used by omp update and the startup update check": "omp update 与启动时更新检查使用的更新通道",
	"Mark misspelled prompt words with the active macOS dictionaries": "用当前启用的 macOS 词典标记拼写错误的输入词",
	"Repaint only the viewport and keep history wrapped at its old width": "只重绘视口，历史保持旧宽度换行",
	"Ordered destinations tried when publishing images for provider access": "发布图片供供应商访问时按序尝试的目标列表",
	"Percentage plus ticks at the speculative and auto-compaction boundaries": "百分比加上投机压缩与自动压缩边界的刻度",
	"Show macOS dictionary word completions as inline hints accepted with Tab": "以行内提示显示 macOS 词典的补全，Tab 采纳",
	"Remote listen port of the ssh reverse forward that your web server proxies to": "ssh 反向转发的远程监听端口，由你的 Web 服务器代理",
	"Retry stops with no visible assistant message; tool calls are excluded (default)": "对没有可见助手消息的停更进行重试；工具调用除外（默认）",
	"Protect expensive prefixes during long tool executions; stops when the agent settles": "长工具执行期间保护昂贵前缀；代理落定后停止",
	"How the line between the left and right segments reflects context usage (box composer only)":
		"左右分段之间的线条如何反映上下文用量（仅框式输入框）",
	"Private scratchpad; not shown to user. Disables supported GPT, Claude, and Gemini reasoning":
		"私有草稿；不展示给用户。关闭受支持的 GPT、Claude 与 Gemini 推理摘要",
	"Externally reachable base URL fronting the blob server (required for ssh, optional for direct)":
		"blob 服务器对外的公网基础地址（ssh 方式必填，直连可选）",
	"Automatically fix syntax errors introduced by edits using AST-based localization and a small model":
		"编辑引入语法错误时，用 AST 定位加小模型自动修复",
	"Enable OMP-native security scan planning, execution, and the read-only security:// resource namespace":
		"启用 OMP 原生安全扫描的规划与执行，以及只读的 security:// 资源命名空间",
	"Re-send the last request with a one-token output budget shortly before its prompt-cache entry expires":
		"在提示缓存条目临期前，以单 token 输出预算重发上一次请求",
	"How the assistant reply is prepared before synthesis: raw, sanitized (strip code/markdown), or summarized.":
		"合成前如何处理助手回复：原文、净化（去代码/markdown）或摘要。",
	"Preferred fallback order for automatic context maintenance; unavailable or failed methods advance to the next choice":
		"自动上下文维护的首选回退顺序；不可用或失败的方式自动前进到下一项",
	"On-device neural TTS model (Kokoro-82M English-first, MeloTTS 中文 for Mandarin/mixed zh-en) used by the local TTS backend":
		"本地语音后端使用的端侧神经语音模型（Kokoro-82M 偏英语，MeloTTS 中文 面向普通话/中英混合）",
	"User-level system-prompt sections ({name, order, text}); applied to every session, overriding same-named preset sections":
		"用户级系统提示词区块（{name, order, text}）；作用于每个会话，同名预设区块被覆盖",
	"Maximum width in terminal columns for inline images (default 100). Set to 0 for unlimited (bounded only by terminal width).":
		"内联图片的最大宽度（终端列数，默认 100）。0 为不限（只受终端宽度约束）。",
	"Automatically recover when the assistant stops without a visible message. Smart also classifies text-only stops with a small model.":
		"助手没有可见消息就停更时自动恢复。Smart 档还会用小模型对纯文本停更分类。",
	"Share one language server per project across musepi instances via the daemon broker (falls back to private servers when unavailable)":
		"通过 daemon 中转在多个 musepi 实例间共享每个项目的语言服务器（不可用时回退私有服务器）",
	"Classifier for Smart unexpected-stop detection: online (the TINY role from /models, else smol) by default, or a local on-device model.":
		"Smart 意外停更检测的分类器：默认在线（/models 里的 TINY 角色，否则 smol），也可用端侧本地模型。",
	"Maximum height in terminal rows for inline images (default 20). Set to 0 to use only the viewport-based limit (60% of terminal height).":
		"内联图片的最大高度（终端行数，默认 20）。0 表示只用视口限制（终端高度的 60%）。",
	"Render Mermaid fenced code blocks as ASCII diagrams (TUI). The desktop transcript renders mermaid blocks as SVG via its own chat preference.":
		"将 Mermaid 代码块渲染为 ASCII 图（TUI）。桌面端对话用自己的聊天偏好把 mermaid 渲染为 SVG。",
	"BCP-47 hint passed to the speech model (e.g. zh, yue, en, ja). Empty = auto-detect — the shipped models are multilingual and usually need no hint.":
		"传给语音模型的 BCP-47 提示（如 zh、yue、en、ja）。留空自动检测——内置模型多语言，通常无需提示。",
	"Explicit terminal backend selection. 'auto' falls back to node-pty on bun-pty failure; 'bun-pty' or 'node-pty' fail loud on unsupported platforms.":
		"显式选择终端后端。auto 在 bun-pty 失败时回退 node-pty；bun-pty 或 node-pty 在不支持的平台上直接报错。",
	"Speculatively summarize in the background as context nears the compaction threshold, then splice the ready result in when the threshold is crossed":
		"上下文接近压缩阈值时后台先做投机摘要，越过阈值后把就绪结果拼接进来",
	"Positive finite active-work timeout for extension tool_call handlers; invalid values use 30000ms, and time awaiting OMP-owned dialogs does not count":
		"扩展 tool_call 处理器的活动工作超时（正有限值）；非法值取 30000ms，等待 OMP 自有对话框的时间不计入",
	"Voice used by the local TTS backend — the voice picker under each tier in Settings → Voice writes this (Kokoro multi-voice, MeloTTS-zh single ZH voice)":
		"本地语音后端使用的音色——设置 → 语音中各档位下方的音色选择器写入（Kokoro 多音色，MeloTTS-zh 单中文音色）",
	"Argv template for the command backend; {file} is the image path, {mime}/{ext} optional. The last URL printed on stdout is used (e.g. pasta -b -f {file})":
		"命令后端的 argv 模板；{file} 是图片路径，{mime}/{ext} 可选。取 stdout 打印的最后一个 URL（如 pasta -b -f {file}）",
	"Use premium long-context windows on models that bill extra past a threshold (e.g. GPT-5.6 1M charges 2x input above 272K); off caps them at the standard-pricing window":
		"对超过阈值加价的长上下文窗口使用premium档（如 GPT-5.6 1M 在 272K 以上输入按 2 倍计费）；关闭则限制在标准定价窗口",
	"Processing tier for Claude requests. `priority` realizes fast mode (`speed: \"fast\"`) on supported direct Anthropic models; ignored on Bedrock/Vertex Claude and via OpenRouter.":
		"Claude 请求的处理档位。priority 在受支持的 Anthropic 直连模型上实现 fast 模式（speed: \"fast\"）；Bedrock/Vertex Claude 与 OpenRouter 忽略。",
	"Maximum concurrent LLM requests per provider id (for example \"openai\" or \"anthropic\"), shared across local OMP processes with this config root. Omitted providers are unlimited.":
		"每个供应商 id 的最大并发 LLM 请求数（如 \"openai\"、\"anthropic\"），同一配置根下的本地 OMP 进程共享。未列出的供应商不限。",
	"Never auto-spend below this many saved resets (0 = the last credit may be spent automatically). Credits about to expire are exempt — a reserved credit that expires preserves nothing.":
		"保存的重置额度低于此数时不自动消耗（0 = 最后一份额度也可自动使用）。临期额度不受此限——保留到过期的额度什么也保不住。",
};

applyBatch(TRANSLATIONS, process.argv.includes("--apply"));
