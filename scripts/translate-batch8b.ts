/**
 * Batch 8B: the longer identity-filled prose strings.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const root = process.cwd();
const apply = process.argv.includes("--apply");

const T: Record<string, string> = {
	"Default timeout for hub message waits (and send await:true) in milliseconds; 0 disables the timeout":
		"hub 消息等待（以及 send await:true）的默认超时（毫秒）；0 关闭超时",
	"Optional path to an exact Julia executable. When set, automatic Julia runtime discovery is skipped.":
		"Julia 可执行文件的精确路径。设置后跳过自动 Julia 运行时发现。",
	"Auto-approve read, write, and exec tools. User policy can still require confirmation or block calls.":
		"自动批准读取、写入与执行工具。用户策略仍可要求确认或拦截调用。",
	"Debounce window in milliseconds for MCP resource updates before injecting them into the conversation":
		"MCP 资源更新注入对话前的防抖窗口（毫秒）",
	"Optional path to an exact Python executable. When set, automatic Python runtime discovery is skipped.":
		"Python 可执行文件的精确路径。设置后跳过自动 Python 运行时发现。",
	"Share viewer/upload base used by /share (encrypted blob upload + viewer; links are <base>/<id>#<key>)":
		"/share 使用的查看/上传基础地址（加密 blob 上传 + 查看器；链接形如 <base>/<id>#<key>）",
	"Show the thinking level as a single icon on the model name instead of a separate ` · <level>` suffix.":
		"思考档位以单个图标显示在模型名上，而不是独立的「 · <档位>」后缀。",
	"Prioritized providers for the web_search tool; unlisted providers retain their default order afterward":
		"web_search 工具的供应商优先级；未列出的供应商保持默认顺序",
	"After the agent stops, nudge it to capture lessons to memory and create/enhance isolated managed skills":
		"代理停下后，提示它把经验沉淀到记忆并创建/完善独立管理的技能",
	"Browser UI used by /collab links; empty derives from collab.relayUrl; explicit http:// is localhost-only":
		"/collab 链接使用的浏览器界面；留空从 collab.relayUrl 推导；显式 http:// 仅限本机",
	"Pair a second model (assigned to the 'advisor' role) that passively reviews each turn and injects notes.":
		"搭配第二个模型（分配为 advisor 角色），被动审阅每个回合并插入备注。",
	"Seconds to wait for the first model stream event; -1 uses provider/env defaults, 0 disables the watchdog":
		"等待首个模型流事件的秒数；-1 用供应商/环境默认，0 关闭看门狗",
	"Prune tool results flagged contextually useless (no matches, timed-out waits) once consumed (cache-aware)":
		"工具结果被消费后，清理被标记为上下文无用的项（无匹配、等待超时）（缓存感知）",
	"How the assistant reply is prepared before synthesis: raw, sanitized (strip code/markdown), or summarized.":
		"合成前如何处理助手回复：原文、净化（去代码/markdown）或摘要。",
	"Session-title model: online (the TINY role from /models, else @smol) by default, or a local on-device model":
		"会话标题模型：默认在线（/models 的 TINY 角色，否则 @smol），也可用端侧本地模型",
	"Shared bank, retains tagged with project:<cwd>. Recall surfaces project + untagged global memories together":
		"共享库，保留项带 project:<cwd> 标签。召回同时呈现项目与未标记的全局记忆",
	"Start language servers on first use (lsp tool or editing a matching file type) instead of at session startup":
		"语言服务器在首次使用时启动（lsp 工具或编辑匹配的文件类型），而不是会话启动时",
	"Ingest new memories into the episodic graph as they are stored, linking them to related entities and memories":
		"新记忆写入时即进入情景图，与相关实体和记忆建立链接",
	"Prevent macOS sleep during active sessions. Each level is cumulative — it adds the flags of all lower levels.":
		"活跃会话期间阻止 macOS 睡眠。各级别累加——包含所有更低级别的标志。",
	"Seconds a model stream may stay silent between events; -1 uses provider/env defaults, 0 disables the watchdog":
		"模型流事件之间的最大静默秒数；-1 用供应商/环境默认，0 关闭看门狗",
	"Advanced: explicit embedding model id that overrides the variant. Leave empty to use mnemopi.embeddingVariant.":
		"高级：显式的嵌入模型 ID，覆盖变体选择。留空使用 mnemopi.embeddingVariant。",
	"Ordered bash command approval rules. Each item has match and approval fields; only '*' wildcards are supported.":
		"有序的 bash 命令审批规则。每项含 match 与 approval 字段；仅支持 '*' 通配。",
	"Expose the optional effort parameter on task spawns, allowing callers to override each subagent's thinking level":
		"在 task 派生上暴露可选的 effort 参数，允许调用方覆盖各子代理的思考档位",
	"Auto-approve read-only and write tools; require confirmation for exec tools such as bash, eval, browser, and task.":
		"自动批准只读与写入工具；bash、eval、browser、task 等执行类工具需要确认。",
	"Use no LLM, the online tiny model (the TINY role from /models, else @smol), or a remote OpenAI-compatible endpoint":
		"不用 LLM、用在线小模型（/models 的 TINY 角色，否则 @smol），或远程 OpenAI 兼容端点",
	"BFS-unfold elidable spans until the summary is at least this many visible lines. 0 keeps only the outermost elisions.":
		"BFS 展开可省略片段，直到摘要至少达到此可见行数。0 表示只保留最外层省略。",
	"Default routing-variant suffix appended to OpenRouter model IDs (overridden when the selector already names a variant)":
		"OpenRouter 模型 ID 默认追加的路由变体后缀（选择器已带变体时覆盖）",
	"Pause the main agent for up to 30 seconds if the advisor falls behind by this many turns. Off disables catch-up delays.":
		"顾问落后此回合数时，主代理最多暂停 30 秒等它。Off 关闭追赶延迟。",
	"Automatically apply successful isolated task changes to the parent checkout; disable to retain patch or branch artifacts":
		"隔离任务变更成功后自动应用到父检出；关闭则保留补丁或分支产物",
	"Enable the generate_image tool (text-to-image generation and editing). Exposed as an xd:// device when tools.xdev is on.":
		"启用 generate_image 工具（文生图与改图）。tools.xdev 开启时作为 xd:// 设备暴露。",
	"Prioritized providers for image generation; unlisted providers follow the active session provider and the built-in order":
		"图片生成的供应商优先级；未列出者跟随当前会话供应商与内置顺序",
	"What to speak: all = assistant messages + thinking; assistant = messages only; yield = only the final message at turn end":
		"朗读范围：all = 助手消息 + 思考；assistant = 仅消息；yield = 仅回合结束的最终消息",
	"Max wait for the first `direnv export` (a cold devenv shell can be slow); on timeout the session runs without the direnv env":
		"首个 direnv export 的最长等待（冷启动 devenv shell 可能很慢）；超时会话将在无 direnv 环境下运行",
	"When on, auto-run one private capture turn at stop (uses extra tokens). When off, only standing auto-learn guidance remains.":
		"开启后停止时自动运行一轮私有捕捉（消耗额外 token）。关闭则只保留常驻的自动学习指引。",
	"Show the full animated setup splash on normal interactive startup without rerunning setup. Quiet Startup still suppresses it.":
		"常规交互启动时播放完整动画启动页而不重跑引导。安静启动仍会跳过它。",
	"After an advisor concern or blocker interrupts, route further concerns/blockers non-interruptingly for this many primary turns.":
		"顾问关注/阻塞中断后，接下来这么多主回合内的后续关注/阻塞改为非中断呈现。",
	"Treat a coding-plan model as near its limit below this remaining percentage. Unknown or unmapped usage keeps the primary model.":
		"编码套餐模型剩余百分比低于此值视为接近上限。用量未知或未映射时保持主模型。",
	"Frame shape snapcompact prints text with (compaction archive and inline imaging). Auto picks a shape tuned for the current model.":
		"snapcompact 打印文本的边框形态（压缩归档与内联成像）。Auto 按当前模型选择适配形态。",
	"Amount of head content kept inline alongside the tail when output spills to artifact (middle elision). 0 disables — keep tail only.":
		"输出溢出到产物时与尾部一并保留的头部内容量（中段省略）。0 关闭——只保留尾部。",
	"Inject one steering notice when a subagent crosses its soft request budget, asking it to wrap up before the 1.5x forced-yield stop.":
		"子代理越过软请求预算时注入一次引导提示，要求在 1.5 倍强制交出停止前收尾。",
	"Wrap paths and URLs in OSC 8 hyperlinks for terminal-native click-to-open (auto: detect support; off: never; always: unconditional)":
		"把路径与 URL 包成 OSC 8 超链接供终端原生点击打开（auto 检测支持；off 从不；always 无条件）",
	"Choose when speech dictation automatically submits: Never, Release (2+ words), Release with complete sentence, or When I Say Submit.":
		"语音听写何时自动提交：从不、松键（2+ 词）、松键且句子完整、或我说提交时。",
	"global = one shared bank; per-project = isolated bank per cwd; per-project-tagged = project-local writes plus global recall visibility":
		"global = 单一共享库；per-project = 按 cwd 隔离；per-project-tagged = 项目本地写入 + 全局召回可见",
	"Past the soft TTL the cached row is returned and refreshed in the background; past the hard TTL it is dropped (seconds; default 7 days)":
		"超过软 TTL 先返回缓存行并后台刷新；超过硬 TTL 直接丢弃（秒；默认 7 天）",
	"Render the workspace directory tree in the system prompt. WARNING: This can bust prompt caching across sessions when files are modified.":
		"在系统提示中渲染工作区目录树。警告：文件变动时可能击穿跨会话的提示缓存。",
	"Enable the github tool (op-based dispatch for repository, issue, pull request, diff, search, checkout, push, and Actions watch workflows)":
		"启用 github 工具（按操作分发仓库、issue、拉取请求、diff、搜索、检出、推送与 Actions 监视流）",
	"Processing tier for OpenAI / OpenAI-Codex requests, and OpenAI-family models routed via OpenRouter (none = omit). Sent as `service_tier`.":
		"OpenAI / OpenAI-Codex 请求及经 OpenRouter 路由的 OpenAI 系模型的处理档位（none = 不发送）。以 service_tier 传递。",
	"Celebrate unscheduled Codex weekly usage resets and newly banked saved resets with a top-third fireworks overlay that remains until Escape":
		"Codex 周用量计划外重置与新入账保存重置时，在屏幕上三分之一处放一段烟花庆祝，按 Escape 消散",
	"Difficulty classifier for the `auto` thinking level: online (the TINY role from /models, else smol) by default, or a local on-device model":
		"auto 思考档位的难度分类器：默认在线（/models 的 TINY 角色，否则 smol），也可用端侧本地模型",
	"Use cmux WKWebView surfaces for browser automation when a cmux socket is available. Set PI_BROWSER_CMUX=0 or PI_BROWSER_CMUX=1 to override.":
		"有 cmux 套接字时用 cmux WKWebView 面做浏览器自动化。设 PI_BROWSER_CMUX=0 或 1 可覆盖。",
	"ONNX execution provider for local tiny models (titles + memory). Default uses CPU-only inference. The PI_TINY_DEVICE env var overrides this.":
		"本地小模型（标题 + 记忆）的 ONNX 执行后端。默认纯 CPU 推理。环境变量 PI_TINY_DEVICE 可覆盖。",
	"Directory to save screenshots. If unset, screenshots go to a temp file. Supports ~. Examples: ~/Downloads, ~/Desktop, /sdcard/Download (Android)":
		"截图保存目录。未设置则存临时文件。支持 ~。示例：~/Downloads、~/Desktop、/sdcard/Download（Android）",
	"At session start, create any built-in mental models (project-conventions, project-decisions, user-preferences) that do not yet exist on the bank.":
		"会话启动时创建库中尚不存在的内置心智模型（project-conventions、project-decisions、user-preferences）。",
	"Choose which mounted-device docs and schemas are inlined in the system prompt. Built-ins keeps core tools inline while MCP and extension tools stay on-demand.":
		"选择哪些已挂载设备的文档与 schema 内联进系统提示。Built-ins 保持核心工具内联，MCP 与扩展工具按需。",
	"global = one shared bank; per-project = isolated bank per cwd; per-project-tagged = shared bank with project tags so global + project memories merge on recall":
		"global = 单一共享库；per-project = 按 cwd 隔离；per-project-tagged = 共享库带项目标签，召回时全局与项目记忆合并",
	"Per-tool approval policies. Set to 'allow' to auto-approve, 'prompt' to require confirmation, or 'deny' to block. Overrides are honored in every approval mode.":
		"按工具的审批策略。allow 自动批准、prompt 需确认、deny 拦截。在每种审批模式下都生效。",
	"When an image is attached to a model without vision support, save it under local:// and inject a description from a vision-capable model instead of dropping it":
		"图片附给不支持视觉的模型时，存到 local:// 并注入由视觉模型生成的描述，而不是直接丢弃",
	"Local embedding model family. en = stronger English model; multilingual = cross-language model. Changing this rebuilds existing memory embeddings on next start.":
		"本地嵌入模型族。en = 更强的英语模型；multilingual = 跨语言模型。更改后下次启动重建现有记忆嵌入。",
	"Render Markdown H1 headings at 2x scale using Kitty's OSC 66 text-sizing protocol. Only takes effect on Kitty terminals; ignored everywhere else. Off by default.":
		"用 Kitty 的 OSC 66 文字缩放协议以 2 倍渲染 Markdown H1。仅 Kitty 终端生效，其余忽略。默认关闭。",
	"Allow subagents spawned via the task tool to use the lsp tool. Off by default to keep subagents cheap; enable when LSP-aware delegation is worth the extra tokens.":
		"允许 task 工具派生的子代理使用 lsp 工具。默认关闭以保持子代理轻量；LSP 感知的委派值得额外 token 时再开。",
	"Automated tool issue reporting (xd://report_issue). On by default; the first report asks for consent, and denying it disables reporting until re-enabled explicitly":
		"自动工具问题上报（xd://report_issue）。默认开启；首次上报会征求同意，拒绝则停用直到显式重新开启",
	"Processing tier for Gemini (Google AI Studio + Vertex) requests, and Google-family models routed via OpenRouter (none = omit). Sent as the top-level `serviceTier` field.":
		"Gemini（Google AI Studio + Vertex）请求及经 OpenRouter 路由的 Google 系模型的处理档位（none = 不发送）。以顶层 serviceTier 字段传递。",
	"When a Gemini reasoning stream emits many consecutive planning headers without calling a tool, interrupt it and inject a reminder to issue a tool call (requires Loop Guard)":
		"Gemini 推理流连续输出大量计划标题而不调用工具时，中断并注入调用工具的提醒（需开启循环防护）",
	"When xd:// Prompt Docs is Built-ins Only, inline dynamic devices whose names match these glob patterns (for example mcp__context_mode_*). Catalog Only ignores this setting.":
		"xd:// Prompt Docs 为 Built-ins Only 时，内联名称匹配这些 glob 的动态设备（如 mcp__context_mode_*）。Catalog Only 忽略此项。",
	"Service Tier for the advisor model. None = standard processing; Inherit = match the main agent's live per-family tiers; pick a value to apply it to the advisor model's family.":
		"顾问模型的服务档位。None = 标准处理；Inherit = 跟随主代理的实时按族档位；选具体值则应用到顾问模型所属族。",
	"Use reliable coding-plan quota reports to prefer same-provider accounts, then configured fallback models, before a hard usage limit. Ordinary configured API keys are excluded.":
		"用可靠的编码套餐配额报告，在硬性用量上限前优先同供应商账号，再走已配置的回退模型。普通配置的 API key 不参与。",
	"Rewrite assistant output into natural spoken prose with the tiny/smol model before synthesis (describes code, drops links and markdown). Falls back to mechanical cleanup on failure":
		"合成前用 tiny/smol 模型把助手输出改写成自然口语（描述代码、去掉链接与 markdown）。失败时退回机械清理",
	"Never auto-spend below this many saved resets (0 = the last credit may be spent automatically). Credits about to expire are exempt — a reserved credit that expires preserves nothing.":
		"保存的重置额度低于此数时不自动消耗（0 = 最后一份额度也可自动使用）。临期额度不受此限——保留到过期的额度什么也保不住。",
	"Default HTTP CDP discovery endpoint (for example http://127.0.0.1:9222) to attach to instead of launching a browser. Explicit app.cdp_url or app.path on the tool call take precedence.":
		"默认的 HTTP CDP 发现端点（如 http://127.0.0.1:9222），命中则附加而不是启动浏览器。工具调用上的显式 app.cdp_url 或 app.path 优先。",
	"How long an idle subagent stays live in memory before being parked to disk (ms). Parked agents are revived automatically when messaged or resumed. 0 keeps idle agents live until exit.":
		"空闲子代理在内存中存活多久后驻留磁盘（毫秒）。被驻留的代理在收到消息或恢复时自动复活。0 表示空闲代理一直存活到退出。",
	"Show the agent run state in the terminal title's separator — an animated spinner while working (a static ':' on Windows), '>' when it's your turn, '!' when the agent is waiting on you":
		"在终端标题分隔符中显示代理运行状态——工作中为动画旋转（Windows 为静态 ':'），轮到你是 '>'，代理在等你时是 '!'",
	"Hard ceiling on summary size while BFS-unfolding. An unfold whose revealed lines would exceed this is skipped (that span stays folded) and unfolding continues with the remaining spans.":
		"BFS 展开时的摘要大小硬上限。展开后行数会超过上限的片段跳过（保持折叠），继续处理其余片段。",
	"While the computer tool operates the host desktop, show a full-screen glow edge, status badge, and per-action target highlight on your displays so you always see what the agent is doing":
		"计算机工具操控桌面时，在显示器上显示全屏辉光边缘、状态徽标与逐步操作的目标高亮，代理在做什么始终可见",
	"Erase and replay terminal scrollback when a block's final form replaces its live preview. When off (default), stale preview copies remain in history and the final content is appended below.":
		"区块最终形态替换实时预览时擦除并重放终端回滚区。关闭（默认）时历史里残留过期预览副本，最终内容追加在下方。",
	"ONNX quantization/precision for local tiny models. Default uses each model's shipped dtype (q4); lower precision is faster, higher is more faithful. The PI_TINY_DTYPE env var overrides this.":
		"本地小模型的 ONNX 量化/精度。默认用模型自带 dtype（q4）；精度越低越快、越高越忠实。环境变量 PI_TINY_DTYPE 可覆盖。",
	"Per-line byte cap for streaming tool outputs (bash, python, js eval) and `read`. Lines wider than this are ellipsis-truncated; remaining bytes up to the next newline are dropped. 0 disables.":
		"流式工具输出（bash、python、js eval）与 read 的每行字节上限。超宽行省略截断，到下一换行前的剩余字节丢弃。0 关闭。",
	"Spend a saved Codex reset automatically when it would otherwise expire within this many hours and either chat window (5h or weekly) has meaningful usage to restore (0 disables expiry salvage).":
		"当保存的 Codex 重置额度将在此小时数内过期、且 5h 或周窗口还有可观用量可恢复时，自动消耗一份（0 关闭临期回收）。",
	"When a paste reaches this many lines, offer a menu to wrap it in a code block, wrap it in XML tags, or save it to a file. 0 disables the menu (large pastes still collapse to a [Paste] marker).":
		"粘贴达到此行数时弹出菜单：包进代码块、包进 XML 标签、或存为文件。0 关闭菜单（大粘贴仍折叠为 [Paste] 标记）。",
	"Service Tier for spawned task/eval subagents. Inherit = match the main agent's live per-family tiers (tracks /fast); pick a value to apply it to whichever family the subagent's model belongs to.":
		"派生的 task/eval 子代理的服务档位。Inherit = 跟随主代理的实时按族档位（跟随 /fast）；选具体值则应用到子代理模型所属族。",
	"Maximum reasoning effort allowed for the task tool's per-spawn effort hint. Lower values prevent callers from escalating subagents above this ceiling; the default preserves the model's full range.":
		"task 工具每次派生的 effort 提示允许的最大推理档位。调低可防止调用方把子代理抬到超过此顶；默认保留模型完整范围。",
	"With in-band tool calls, stop the model immediately when it starts hallucinating a tool result mid-turn. Disable to let the model finish generating and discard the fabricated continuation instead.":
		"带内工具调用时，模型在回合中开始幻觉工具结果就立即停止。关闭则让模型生成完，然后丢弃伪造的续写。",
	"Cache system prompt + tool specs and keep an append-only message log so provider prefix caches (DeepSeek, Xiaomi/SGLang, Anthropic) hit at maximum rate. Auto enables for known prefix-cache providers.":
		"缓存系统提示 + 工具规格并保持仅追加的消息日志，让供应商前缀缓存（DeepSeek、Xiaomi/SGLang、Anthropic）以最高命中率命中。Auto 对已知支持前缀缓存的供应商启用。",
	"Per-request timeout for the inspect_image vision-model call, in milliseconds. A stalled provider fails fast with a timeout error instead of blocking until manual abort. Set to 0 to disable the timeout.":
		"inspect_image 视觉模型调用的单次超时（毫秒）。卡住的供应商快速失败并报超时，而不是阻塞到手动中止。0 关闭超时。",
	"Enable the vault:// internal URL for reading and editing Obsidian vault content via the Obsidian CLI. When disabled, vault:// resolution is refused and the vault:// entry is omitted from the system prompt.":
		"启用 vault:// 内部 URL，经 Obsidian CLI 读写 Obsidian 库内容。关闭时 vault:// 解析被拒，系统提示中也省略 vault:// 条目。",
	"Use the terminal's default background for the status line instead of the theme's `statusLineBg`. Powerline end caps are dropped because they need a contrasting fill to bridge into the surrounding terminal.":
		"状态线用终端默认背景而非主题的 statusLineBg。Powerline 端帽会去掉——它们需要对比填充来衔接周围终端。",
	"Controls the inspect_image tool, which delegates image understanding to a vision-capable model. 'auto' exposes it only when the active model lacks native image input; 'on' always exposes it; 'off' never does.":
		"控制 inspect_image 工具（把图像理解委托给有视觉的模型）。auto 仅在当前模型无原生图像输入时暴露；on 始终暴露；off 从不。",
	"Hard wall-clock limit per subagent (ms). 0 disables it. Defense-in-depth against provider-side stream hangs that escape the inference-layer watchdog; triggers a normal subagent abort with a 'timed out' reason.":
		"每个子代理的硬墙钟上限（毫秒）。0 关闭。对逃过推理层看门狗的供应商侧流挂起做纵深防御；触发常规子代理中止，原因为「超时」。",
	"Render full tool descriptors in the system prompt and strip top-level/nested descriptions from provider tool schemas so descriptor text is sent once. Auto enables this for Gemini models and disables it otherwise":
		"在系统提示中渲染完整工具描述符，并从供应商工具 schema 里剥掉顶层/嵌套描述，让描述文本只发一次。Auto 对 Gemini 模型启用，其余关闭",
	"Default approval behavior for tool calls. 'Always ask' auto-approves read-only tools only. 'Write' auto-approves read and workspace-write tools. 'Yolo' auto-approves all tiers; user policy may still prompt or block.":
		"工具调用的默认审批行为。「总是询问」仅自动批准只读工具。「写入」自动批准读取与工作区写入。「Yolo」全档自动批准；用户策略仍可提示或拦截。",
	"Read curated reflect summaries (mental models) into developer instructions at boot. Loads existing models on the bank — does not write. Pair with hindsight.mentalModelAutoSeed to also auto-create the built-in seed set.":
		"启动时把精选的 reflect 摘要（心智模型）读入开发者指令。只读取库中已有模型——不写入。配合 hindsight.mentalModelAutoSeed 可自动创建内置种子集。",
	"Maximum wait between retries, in ms. When the provider asks us to wait longer than this and no credential or model fallback succeeds, the request fails fast instead of sleeping (e.g. 3-hour Anthropic rate-limit windows).":
		"重试之间的最大等待（毫秒）。供应商要求等待超过此值且没有凭据或模型回退成功时，请求快速失败而不是干等（如 Anthropic 3 小时限流窗口）。",
	"Auto-load a repo's direnv/devenv `.envrc` into the bash session so devenv tools and env vars are present without manual `direnv exec`. Honors direnv's allow list: an `.envrc` you haven't `direnv allow`ed is never executed":
		"把仓库的 direnv/devenv .envrc 自动加载进 bash 会话，devenv 工具与环境变量无需手动 direnv exec 即就位。遵循 direnv 允许清单：未 direnv allow 过的 .envrc 绝不执行",
	"Only auto-redeem when the natural unblock — the latest reset among the exhausted 5h/weekly windows — is at least this many minutes away (don't spend a scarce credit to save a short wait). Raise it (e.g. 360) to ignore 5h-only blocks.":
		"只有当自然解封时间（已耗尽的 5h/周窗口中最近的一次重置）至少在这么多分钟之后才自动兑换（不为省一小段等待消耗稀缺额度）。调高（如 360）可忽略仅 5h 的封禁。",
	"Highest effort the `auto` classifier may resolve. `xhigh` keeps the classifier one tier below the top, so only an explicit `ultrathink` reaches `max`; `max` lets a turn the classifier judges exceptional bill the top tier on models that expose it.":
		"auto 分类器可解析的最高档位。xhigh 让分类器保持在顶档下一级，只有显式 ultrathink 才到 max；max 允许分类器判定 exceptional 的回合在使用该档位的模型上按最高档计费。",
	"Which package registry installs plugins from. Auto asks the official registry first and tries the public mirror when a failure is one it could answer; Custom uses the URL below; Package manager leaves it to the package manager's own configuration.":
		"插件从哪个包仓库安装。Auto 先问官方仓库，失败属于可重试类型时再试公共镜像；Custom 使用下方地址；Package manager 交给包管理器自己的配置。",
	"When a Claude Fable 5 / Mythos 5 request is blocked by Anthropic's safety classifier, retry it on Claude Opus 4.8 server-side (Anthropic `server-side-fallback-2026-06-01` beta). Opt-in — leaving this off preserves the pre-fallback behavior for every request.":
		"Claude Fable 5 / Mythos 5 请求被 Anthropic 安全分类器拦截时，服务端在 Claude Opus 4.8 上重试（Anthropic server-side-fallback-2026-06-01 beta）。需主动开启——关闭时所有请求保持回退前的行为。",
	"Extra workspace directories added to every session as additional roots (multi-root workspace). Managed live via /add-dir and /remove-dir. Paths resolve relative to cwd; absolute paths recommended. The agent is told these roots exist and can read/grep/glob them.":
		"作为附加根加入每个会话的额外工作区目录（多根工作区）。通过 /add-dir 与 /remove-dir 实时管理。路径相对 cwd 解析；建议绝对路径。代理会被告知这些根的存在，可对它们 read/grep/glob。",
	"How much of a RUNNING turn to keep in view. 'Show all' (default) streams every row; a number keeps only the latest N and folds the rest into a '+N more' line, so a long task holds still. Finished turns always fold into the activity summary, whatever this is set to":
		"运行中的回合保留多少在视野内。Show all（默认）流式显示每一行；数字则只保留最近 N 行，其余折叠为「+N 更多」行，长任务因此保持稳定。已完成的回合无论取值如何都折叠进活动摘要",
	"Mount rarely-used (discoverable) tools under xd:// device URLs driven via read/write instead of shipping their schemas on every request. Sessions without a granted write tool skip mounting and expose every tool top-level. Disable to expose every enabled tool top-level.":
		"把低频（可发现）工具挂到 xd:// 设备 URL 下、经 read/write 驱动，而不是每次请求都带上全部 schema。未授予 write 工具的会话跳过挂载、所有工具照常顶层暴露。关闭即全部顶层暴露。",
	"How long a `hub` wait watches background jobs before returning the current state. A fixed value waits that exact duration every time. `smart` adapts: it starts at 5s and lengthens with each back-to-back wait (up to 5m), then resets to 5s after about a minute without waiting.":
		"hub wait 观察后台任务多久后返回当前状态。固定值每次等满该时长。smart 自适应：从 5s 起随连续等待拉长（至多 5m），约一分钟未等待后重置回 5s。",
	"Drive your own Chrome tabs through the musepi browser relay. Install the extension once (`musepi browser-relay install`); the relay server auto-starts when the browser tool needs it. Takes precedence over Browser CDP URL; set PI_BROWSER_RELAY=0 or PI_BROWSER_RELAY=1 to override.":
		"通过 musepi 浏览器中继驱动你自己的 Chrome 标签页。扩展只需安装一次（musepi browser-relay install）；浏览器工具需要时中继服务自动启动。优先于 Browser CDP URL；设 PI_BROWSER_RELAY=0 或 1 可强制覆盖。",
	"Controls how tools are exposed to the model. Auto uses provider-native tool calls unless the selected model is marked as not supporting them, then falls back to the GLM owned dialect. Native forces provider-native tools; the other values force the named owned dialect. Applies on session start.":
		"控制工具以何种方式暴露给模型。Auto 用供应商原生工具调用，所选模型标记为不支持时回退 GLM 自有方言。Native 强制原生；其余值强制对应方言。会话启动时生效。",
	"Start on the active model, then switch to a fast/cheap model (default the 'smol' role) at the first edit/write after the plan nudge's todo list exists — the strong model plans, commits the todos, and starts the implementation before handing off. Overridable per session with --prewalk / --no-prewalk.":
		"以当前模型起步，在计划提示的待办清单就绪后的第一次编辑/写入时切换到快/廉价模型（默认 smol 角色）——强模型负责规划、提交待办并启动实现，然后交接。可用 --prewalk / --no-prewalk 按会话覆盖。",
	"Spend saved Codex rate-limit resets automatically: restore an account blocked by an exhausted 5h or weekly window when a turn is stuck and no other account can take over, and salvage credits that are about to expire. unset asks before the first spend, yes spends without prompting, and no disables both checks.":
		"自动消耗保存的 Codex 限流重置：轮次卡住且没有其他账号可接手时，恢复被耗尽的 5h/周窗口封禁的账号，并回收临期额度。unset 在首次消耗前询问，yes 不再询问，no 同时关闭两项。",
	"Soft per-subagent request budget (assistant requests per run). Crossing it injects a wrap-up steering notice (see task.softRequestBudgetNotice); at 1.5x the budget the run is force-stopped and the agent must yield its partial findings. 0 disables the guard. Bundled scout/sonic agents cap out at a lower built-in budget, so a value below that cap still applies to them.":
		"每个子代理的软请求预算（每次运行的助手请求数）。越过即注入收尾引导提示（见 task.softRequestBudgetNotice）；到 1.5 倍预算强制停止运行，代理必须交出部分结论。0 关闭防护。内置 scout/sonic 代理有更低的内建上限，低于该上限的取值对它们同样生效。",
	"Switch the task tool to its batch shape: one call carries { context, tasks[] } — one subagent per item, with an optional per-item agent (defaulting to the session spawn-policy agent), per-item isolation, and a required shared context prepended to every assignment. With async.enabled=true, each spawn runs as an independent background agent with the normal idle/parked lifecycle; otherwise the call blocks for merged results. Disable to restore the flat single-spawn schema.":
		"把 task 工具切换到批量形态：一次调用携带 { context, tasks[] }——每项一个子代理，可按项指定代理（默认会话派生策略代理）、按项隔离，且必须提供拼接在每个任务前的共享上下文。async.enabled=true 时每次派生都是独立后台代理、走正常的空闲/驻留生命周期；否则调用阻塞等待合并结果。关闭恢复扁平的单次派生 schema。",
};

let n = 0;
const file = path.resolve(root, "packages/client-core/src/i18n/zh-CN/settings.ts");
let s = fs.readFileSync(file, "utf8");
for (const [k, v] of Object.entries(T)) {
	const from = `${JSON.stringify(k)}: ${JSON.stringify(k)},`;
	if (s.includes(from)) {
		s = s.split(from).join(`${JSON.stringify(k)}: ${JSON.stringify(v)},`);
		n++;
	}
}
if (apply) fs.writeFileSync(file, s);
console.log(`replaced ${n} identity values (of ${Object.keys(T).length} provided)${apply ? "" : " (dry run)"}`);
