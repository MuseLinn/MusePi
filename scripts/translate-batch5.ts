/**
 * Batch 5 (final): the remaining long prose descriptions — isolation, browser,
 * speech models, worktrees, model-role fallback JSON.
 */
import { applyBatch } from "./schema-batch-apply.ts";

const TRANSLATIONS: Record<string, string> = {
	"Isolation backend for subagents. \"auto\" lets the native PAL pick the best available backend (CoW-aware filesystems, then overlayfs/ProjFS, then a git worktree / recursive-copy fallback).":
		"子代理的隔离后端。auto 由原生 PAL 自动选择最佳可用后端（先 CoW 感知的文件系统，再 overlayfs/ProjFS，最后回退 git worktree / 递归复制）。",
	"Spend a saved Codex reset automatically when it would otherwise expire within this many hours and either chat window (5h or weekly) has meaningful usage to restore (0 disables expiry salvage).":
		"当保存的 Codex 重置额度将在此小时数内过期、且 5h 或周窗口还有可观用量可恢复时，自动消耗一份（0 关闭临期回收）。",
	"Serving window for locally hosted image URLs, measured from the last time a conversation sent them; resuming a conversation re-arms the window at the same link. 0 keeps links alive while the broker runs":
		"本地托管图片 URL 的服务窗口，从会话最后一次发送图片起计；恢复会话会以同一链接重开窗口。0 表示 broker 运行期间链接一直有效",
	"Maximum number of inline images kept as live terminal graphics (default 8). Older images fall back to a text placeholder via a full redraw once the limit is exceeded. Set to 0 to keep every image (no limit).":
		"以终端实时图形保留的内联图片上限（默认 8）。超限后旧图片在整屏重绘时退化为文字占位。0 表示全部保留（不限制）。",
	"Publish outgoing images through the configured backend chain and send URL-fetching providers short URLs instead of inline base64. Falls back to inline automatically when every backend or a provider fetch fails":
		"通过配置的后端链发布外发图片，向支持抓取 URL 的供应商发送短链接而非内联 base64。所有后端或供应商抓取失败时自动回退内联",
	"Serving path for Fireworks requests. Priority sends `service_tier: \"priority\"` for higher reliability during peak traffic at a higher price; Standard omits it. Fast (`-fast`) models ignore this — Fast is its own serving path.":
		"Fireworks 请求的服务路径。Priority 发送 service_tier: \"priority\"，高峰期可靠性更高、价格更贵；Standard 不发送。Fast（-fast）模型忽略此项——Fast 本身就是独立服务路径。",
	"Activate the extension bootstrap/lifecycle tool set (extension_load, extension_reload, ext_define, …) from session start. Default-off keeps their schemas out of ordinary sessions; the creator preset enables them automatically.":
		"从会话开始即启用扩展引导/生命周期工具集（extension_load、extension_reload、ext_define 等）。默认关闭，普通会话不带这些 schema；creator 预设会自动启用。",
	"Only auto-redeem when the natural unblock — the latest reset among the exhausted 5h/weekly windows — is at least this many minutes away (don't spend a scarce credit to save a short wait). Raise it (e.g. 360) to ignore 5h-only blocks.":
		"只有当自然解封时间（已耗尽的 5h/周窗口中最近的一次重置）至少在这么多分钟之后才自动兑换（不为省一小段等待消耗稀缺额度）。调高（如 360）可忽略仅 5h 的封禁。",
	"Local CDP endpoint of the desktop GUI's managed browser (default http://127.0.0.1:9230). The running app's bridge binds the first free port in 9230-9239 and that ACTUAL port is what gets used; this value only applies when no bridge is up.":
		"桌面 GUI 托管浏览器的本地 CDP 端点（默认 http://127.0.0.1:9230）。运行中的应用桥接会绑定 9230-9239 里第一个空闲端口并以实际端口为准；此值只在桥接未启动时生效。",
	"Which package registry installs plugins from. Auto asks the official registry first and tries the public mirror when a failure is one it could answer; Custom uses the URL below; Package manager leaves it to the package manager's own configuration.":
		"插件从哪个包仓库安装。Auto 先问官方仓库，失败属于可重试类型时再试公共镜像；Custom 使用下方地址；Package manager 交给包管理器自己的配置。",
	"Ceiling in seconds for every tool, applied to the agent's explicit timeout AND to the tool's default when it omits one (0 = no limit). Lowering it is how you cut the eval kernel's 30s default; raise it for long-running Python/Julia cells (per-session, no restart).":
		"所有工具的超时上限（秒），同时约束代理显式设置的超时和工具未设置时的默认值（0 = 不限制）。调低可压缩 eval 内核默认的 30s；调高适合长时间运行的 Python/Julia 单元（按会话生效，无需重启）。",
	"Mount rarely-used (discoverable) tools under xd:// device URLs driven via read/write instead of shipping their schemas on every request. Sessions without a granted write tool skip mounting and expose every tool top-level. Disable to expose every enabled tool top-level.":
		"把低频（可发现）工具挂到 xd:// 设备 URL 下、经 read/write 驱动，而不是每次请求都带上全部 schema。未授予 write 工具的会话跳过挂载、所有工具照常顶层暴露。关闭即全部顶层暴露。",
	"Base directory for agent-managed worktrees — task-isolation copies, `github` PR checkouts, and `musepi worktree` cleanup all live here. Unset uses ~/.musepi/wt. Must be an absolute or ~-relative path; relative paths are ignored. The MUSEPI_WORKTREE_DIR env var overrides this.":
		"代理管理的 worktree 基目录——任务隔离副本、github PR 检出、musepi worktree 清理都在这里。未设置用 ~/.musepi/wt。必须是绝对路径或 ~ 相对路径；相对路径被忽略。环境变量 MUSEPI_WORKTREE_DIR 优先于本项。",
	"Drive your own Chrome tabs through the musepi browser relay. Install the extension once (`musepi browser-relay install`); the relay server auto-starts when the browser tool needs it. Takes precedence over Browser CDP URL; set PI_BROWSER_RELAY=0 or PI_BROWSER_RELAY=1 to override.":
		"通过 musepi 浏览器中继驱动你自己的 Chrome 标签页。扩展只需安装一次（musepi browser-relay install）；浏览器工具需要时中继服务自动启动。优先于 Browser CDP URL；设 PI_BROWSER_RELAY=0 或 1 可强制覆盖。",
	"Fixed token limit for context maintenance; overrides percentage if set. Set this to cap context well below a model's physical window — useful when long-context tokens bill at a higher rate past a threshold (e.g. cap a 500K model at 190000), or when very long contexts degrade attention quality.":
		"上下文维护的固定 token 上限；设置后覆盖百分比。用它把上下文压到远低于模型物理窗口——适用于长上下文 token 超阈值加价（如把 500K 模型压到 190000），或超长上下文明显劣化注意力质量时。",
	"Spend saved Codex rate-limit resets automatically: restore an account blocked by an exhausted 5h or weekly window when a turn is stuck and no other account can take over, and salvage credits that are about to expire. unset asks before the first spend, yes spends without prompting, and no disables both checks.":
		"自动消耗保存的 Codex 限流重置：轮次卡住且没有其他账号可接手时，恢复被耗尽的 5h/周窗口封禁的账号，并回收临期额度。unset 在首次消耗前询问，yes 不再询问，no 同时关闭两项。",
	"Restrict browser navigation to public http/https sites: block localhost, private networks and credentials-in-URL, and re-check DNS before navigating (DNS-rebinding guard). OFF by default because navigating localhost dev servers is a core feature; enable for workflows that need a strictly public browser surface.":
		"把浏览器导航限制在公网 http/https：阻止 localhost、内网与带凭据的 URL，导航前复查 DNS（防 DNS 重绑定）。默认关闭——访问 localhost 开发服务器是核心功能；需要严格公网浏览面的工作流再开启。",
	"Arm prewalk for the bundled generic `task` subagent: it starts on its resolved model, plans and begins the implementation, then hands off to the 'smol' role at its first edit/write. Per-agent overrides (task.agentPrewalk, configured from the /agents hub) and user agent `prewalk` frontmatter apply regardless of this toggle.":
		"为内置通用 task 子代理启用 prewalk：以解析到的模型起步、规划并开始实现，在第一次编辑/写入时移交 'smol' 角色。按代理的覆盖（/agents 中心的 task.agentPrewalk）与用户代理的 prewalk frontmatter 不受此开关影响。",
	"Local on-device speech model. Whisper base/small/large-v3-turbo tiers (transformers.js) are multilingual — Chinese ready (Whisper small is the default); SenseVoiceSmall (sherpa-onnx, INT8) is Chinese-optimized for Mandarin/Cantonese and mixed zh/en speech (auto/zh/en/yue/ja/ko); Parakeet TDT v3 (sherpa-onnx) tops accuracy/speed for English and European languages but does not support Chinese. Downloaded on first use.":
		"端侧本地语音模型。Whisper base/small/large-v3-turbo（transformers.js）多语言、中文可用（默认 Whisper small）；SenseVoiceSmall（sherpa-onnx, INT8）面向普通话/粤语及中英混说优化（auto/zh/en/yue/ja/ko）；Parakeet TDT v3（sherpa-onnx）英语与欧洲语言精度/速度最佳但不支持中文。首次使用时下载。",
	"Drive the in-app managed browser (the desktop GUI's right-pane browser, Electron WebContentsView over a local CDP bridge) instead of launching a separate Chromium: the agent's pages are visible in the panel and share its persistent login state. OFF by default in the CLI/TUI; while the desktop app is running its bridge is live and this turns ON by default — set it to false explicitly to force a headless browser. Takes precedence over Headless Browser; explicit app.cdp_url/path and Browser Relay still win.":
		"驱动应用内托管浏览器（桌面 GUI 右栏浏览器，Electron WebContentsView 走本地 CDP 桥）而非另起 Chromium：代理的页面在面板中可见并共享其持久登录态。CLI/TUI 默认关；桌面应用运行时桥接在线、此项默认开——显式设 false 可强制无头浏览器。优先于 Headless Browser；显式 app.cdp_url/path 与 Browser Relay 仍然最优先。",
	"JSON object mapping model roles, model selectors (\"provider/model-id\"), or provider wildcards (\"provider/*\") to ordered fallback selectors, e.g. {\"default\":[\"openai/gpt-4o-mini\"],\"google-antigravity/*\":[\"google/*\",\"google-vertex/*\"]}. Model-oriented keys apply whenever that model/provider is active, regardless of role; a \"provider/*\" entry keeps the failing model's id and swaps the provider. An id-prefixed wildcard (\"openrouter/google/*\") re-prefixes the failing model's bare id (google-antigravity/gemini-x -> openrouter/google/gemini-x) and, used as a key, matches only that provider's ids under the prefix.":
		"JSON 对象：把模型角色、模型选择器（\"provider/model-id\"）或供应商通配（\"provider/*\"）映射到有序回退选择器，如 {\"default\":[\"openai/gpt-4o-mini\"],\"google-antigravity/*\":[\"google/*\",\"google-vertex/*\"]}。面向模型的键在该模型/供应商活跃时生效、与角色无关；\"provider/*\" 条目保留失败模型的 id、只换供应商。带 id 前缀的通配（\"openrouter/google/*\"）会给失败模型的裸 id 重新加前缀（google-antigravity/gemini-x → openrouter/google/gemini-x），作为键时只匹配该前缀下此供应商的 id。",
};

applyBatch(TRANSLATIONS, process.argv.includes("--apply"));
