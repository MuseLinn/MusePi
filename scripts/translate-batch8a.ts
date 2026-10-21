/**
 * Batch 8A: translate the 108 shorter identity-filled prose strings (Shell
 * page and friends — post-migration additions the repair could only fill with
 * identity). Writes in place: same key, value replaced.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const root = process.cwd();
const apply = process.argv.includes("--apply");

const T: Record<string, string> = {
	"How rules can repeat: once per session or after a message gap": "规则如何重复：每会话一次，或在消息间隔后",
	"intfloat/multilingual-e5-large (1024d), cross-language recall":
		"intfloat/multilingual-e5-large（1024 维），跨语言召回",
	"Name shown to other collab participants (default: OS username)": "展示给其他协作参与者的名称（默认：系统用户名）",
	"Render non-JSON MCP text results as Markdown in the transcript": "在对话中把非 JSON 的 MCP 文本结果渲染为 Markdown",
	"musepi browser relay endpoint (default http://127.0.0.1:9224).":
		"musepi 浏览器中继端点（默认 http://127.0.0.1:9224）。",
	"Let standalone workflowz append its hidden eval workflow notice": "允许独立 workflowz 追加其隐藏的 eval 工作流提示",
	"Allow the eval tool to dispatch Python cells to the IPython kernel":
		"允许 eval 工具把 Python 单元派发到 IPython 内核",
	"Check eligibility, then ask before spending the first saved reset.": "先检查资格，再在消耗第一份保存重置前询问。",
	"Use the online tiny model (the TINY role from /models, else @smol)":
		"使用在线小模型（/models 的 TINY 角色，否则 @smol）",
	"full-session = upsert one document per session, last-turn = chunked":
		"full-session = 每会话更新一篇文档；last-turn = 分块",
	"API format for Kimi Code provider (auto follows live model metadata)":
		"Kimi Code 供应商的 API 格式（auto 跟随在线模型元数据）",
	"Enable the browser tool for scripted Chromium automation (puppeteer)":
		"启用浏览器工具进行脚本化 Chromium 自动化（puppeteer）",
	"Priority serving path: higher reliability, premium per-token pricing": "优先服务路径：可靠性更高，token 单价更高",
	"Use the session name color for the editor border and status line gap": "输入框边框与状态线间隔使用会话名颜色",
	"Speak the assistant's output aloud through the speakers as it streams": "助手输出流式生成时通过扬声器朗读",
	"What happens between /loop iterations before re-submitting the prompt": "/loop 迭代之间、重新提交提示词前的行为",
	"Commit message style for nested repo changes (generic or AI-generated)":
		"嵌套仓库变更的提交信息风格（通用或 AI 生成）",
	"How isolated task changes are integrated (patch apply or branch merge)": "隔离任务变更如何合入（打补丁或分支合并）",
	"Penalty for introducing already-present tokens (-1 = provider default)":
		"引入已存在 token 的惩罚（-1 = 供应商默认）",
	"Off, local summary pipeline, Mnemopi SQLite, or Hindsight remote memory":
		"关闭、本地摘要管线、Mnemopi SQLite 或 Hindsight 远程记忆",
	"Select the edit tool variant (replace, patch, hashline, or apply_patch)":
		"选择编辑工具变体（replace、patch、hashline 或 apply_patch）",
	"Source outline mode for cat/read of source files: default or aggressive":
		"源码文件的 cat/read 大纲模式：default 或 aggressive",
	"Write to a project-local bank but merge project + shared recall results":
		"写入项目本地库，但召回合并项目与共享结果",
	"Allow the eval tool to dispatch Ruby cells to the persistent Ruby kernel":
		"允许 eval 工具把 Ruby 单元派发到持久 Ruby 内核",
	"Enable plan mode for read-only exploration and planning before execution": "启用计划模式：执行前只读探索与规划",
	"Keep the IPython kernel alive across eval calls or start fresh each time":
		"IPython 内核跨 eval 调用保持存活，或每次新建",
	"Maximum lines of tail content kept inline when output spills to artifact": "输出溢出到产物时行内保留的最大尾部行数",
	"The original snapcompact shape (pre-shape-table sessions rendered this).":
		"原始 snapcompact 形态（形态表之前的会话渲染此项）。",
	"Tool output above this size is saved as an artifact; tail is kept inline":
		"超过此大小的工具输出存为产物；尾部保留在行内",
	"Apply loop guard to assistant prose messages in addition to thinking logs":
		"循环防护除思考日志外也作用于助手正文消息",
	"How strongly to push automatic todo-list creation after the first message": "首条消息后自动创建待办清单的推进强度",
	"Inline descriptors for Gemini models; keep them in tool schemas otherwise":
		"Gemini 模型用行内描述符；其余模型保留在工具 schema 中",
	"Render read tool results inline in the transcript instead of summary rows":
		"read 工具结果在对话中内联渲染，而不是摘要行",
	"Use whatever the package manager is configured with (.npmrc, bunfig.toml)":
		"使用包管理器已有配置（.npmrc、bunfig.toml）",
	"Allow the eval tool to dispatch JavaScript cells to the in-process runtime":
		"允许 eval 工具把 JavaScript 单元派发到进程内运行时",
	"Allow the eval tool to dispatch Julia cells to the persistent Julia kernel":
		"允许 eval 工具把 Julia 单元派发到持久 Julia 内核",
	"Ask the agent to describe the intent of each tool call before executing it": "让代理在执行每个工具调用前先描述意图",
	"Delay before completed or abandoned todos are removed from the todo widget":
		"已完成或已放弃的待办从组件移除前的延迟",
	"Isolated bank per cwd basename — projects cannot see each other's memories":
		"按 cwd 名隔离记忆库——项目之间互不可见",
	"Model ID for Gemini Google Search grounding. Defaults to gemini-2.5-flash.":
		"Gemini Google 搜索 grounding 的模型 ID。默认 gemini-2.5-flash。",
	"Reject edits anchored on lines a prior read/search never displayed in full":
		"拒绝锚定在之前 read/search 从未完整显示过的行上的编辑",
	"Reveal assistant text and streamed tool input smoothly while chunks arrive":
		"内容分块到达时平滑显示助手文字与流式工具输入",
	"Use Responses streaming compaction for compatible remote compaction models":
		"兼容的远程压缩模型使用 Responses 流式压缩",
	"Auto-select the recommended ask option after this many seconds (0 disables)":
		"这么多秒后自动选择推荐的 ask 选项（0 关闭）",
	"Prefer local on-device TTS; route .mp3 output to xAI when credentials exist":
		"优先端侧 TTS；有凭据时 .mp3 输出走 xAI",
	"Promote to a larger-context model on context overflow instead of compacting":
		"上下文溢出时升级到更大窗口的模型而不是压缩",
	"Auto-approve read-only tools; require confirmation for write and exec tools.":
		"只读工具自动批准；写入与执行工具需要确认。",
	"Choose whether update notes start as a summary, full details, or stay hidden":
		"更新说明默认展开为摘要、完整详情还是收起",
	"Enable the launch tool for supervising shared long-running project processes":
		"启用 launch 工具管理共享的长运行项目进程",
	"Enable the tiered query result cache for repeated and similar recall queries":
		"为重复与相似召回查询启用分层结果缓存",
	"Save generated handoff documents to markdown files for the auto-handoff flow":
		"自动交接流程把生成的交接文档存为 markdown 文件",
	"What happens to playback when dictation starts: duck (drop volume) or pause.":
		"开始听写时朗读如何处理：降低音量或暂停。",
	"Let standalone orchestrate append its hidden multi-agent orchestration notice":
		"允许独立 orchestrate 追加其隐藏的多代理编排提示",
	"Only move loaded context-file instructions to images, when that saves tokens.":
		"仅当确实节省 token 时才把上下文文件指令转为图片。",
	"Sampling temperature (0 = deterministic, 1 = creative, -1 = provider default)":
		"采样温度（0 = 确定性，1 = 创意，-1 = 供应商默认）",
	"Embedded Silver TrueType font on a 16px grid for CJK and other non-Latin text.":
		"内嵌 Silver TrueType 字体（16px 网格），覆盖 CJK 等非拉丁文本。",
	"Rule names to ignore entirely (applies to bundled defaults and your own rules)":
		"完全忽略的规则名（作用于内置默认与自定义规则）",
	"Automatically background long-running bash commands and deliver the result later":
		"长时间运行的 bash 命令自动转后台，结果稍后交付",
	"Display the actual model ID used by each subagent in the task widget status line":
		"在任务组件状态行显示每个子代理实际使用的模型 ID",
	"Push to a secret gist (needs authenticated gh), falling back to the share server":
		"推送到私密 gist（需 gh 已登录），失败回退共享服务器",
	"Consecutive identical tool calls required before the corrective steer is injected":
		"触发纠偏引导前所需的连续相同工具调用次数",
	"Files with fewer total lines are read verbatim instead of structurally summarized":
		"总行数较少的文件直接原文读取，不做结构化摘要",
	"Full URL receiving Auto QA JSON reports (default https://qa.omp.sh/v1/grievances)":
		"接收 Auto QA JSON 报告的完整地址（默认 https://qa.omp.sh/v1/grievances）",
	"Generate a brief LLM recap of where things stand after the terminal has been idle":
		"终端空闲后生成一段简短的 LLM 现状回顾",
	"Return structural code summaries when read is called without an explicit selector":
		"read 未带显式 selector 时返回结构化代码摘要",
	"Detect consecutive identical tool calls across turns and inject a corrective steer":
		"跨回合检测连续相同工具调用并注入纠偏引导",
	"Enable the tts tool for on-device (Kokoro) or xAI Grok Voice speech-file synthesis":
		"启用 tts 工具进行端侧（Kokoro）或 xAI Grok Voice 语音文件合成",
	"Upload to the share server (no GitHub account needed; avoids gist API rate limits)":
		"上传到共享服务器（无需 GitHub 账号；避开 gist API 限流）",
	"Backend for the tts tool: local on-device neural TTS (Kokoro-82M) or xAI Grok Voice":
		"tts 工具后端：端侧神经语音（Kokoro-82M）或 xAI Grok Voice",
	"Enable the scriptable host-desktop control tool (screenshots, input, accessibility)":
		"启用可脚本化的桌面控制工具（截图、输入、辅助功能）",
	"Show a divider above an assistant turn whose request lost (missed) the prompt cache":
		"请求未命中（丢失）提示缓存的助手回合上方显示分隔线",
	"Enable hidden notices for standalone ultrathink, orchestrate, and workflowz keywords":
		"为独立 ultrathink、orchestrate、workflowz 关键词启用隐藏提示",
	"Suggest emojis from `:name:` shortcodes and expand text emoticons like `:D` or `:-)`":
		"从 `:name:` 短码推荐 emoji，并展开 `:D`、`:-)` 等文字颜文字",
	"Emit OSC 9;4 indeterminate progress while the agent or context maintenance is running":
		"代理或上下文维护运行时发出 OSC 9;4 不确定进度",
	"Optional shared bank base name. Per-project modes derive project-local banks from it.":
		"可选的共享库名。按项目模式据此派生项目本地库。",
	"Show git branch, status, and PR information in the TUI and watch repository metadata.":
		"在 TUI 中显示 git 分支、状态与 PR 信息，并监视仓库元数据。",
	"Tool names that may repeat consecutively without triggering the cross-turn loop guard":
		"允许连续重复而不触发跨回合循环防护的工具名",
	"What to do when every same-provider coding-plan account is inside the reserve margin.":
		"同供应商所有编码套餐账号都进入保留余量时的处理。",
	"Also block all system sleep on AC and declare the user active (caffeinate -i -d -s -u)":
		"接电源时同时阻止系统睡眠并声明用户活跃（caffeinate -i -d -s -u）",
	"Compress verbose shell output (git, npm, cargo, etc.) before returning it to the agent":
		"把冗长的 shell 输出（git、npm、cargo 等）压缩后返回给代理",
	"Minimum delay between Exa web search requests in milliseconds; set 0 to disable pacing":
		"Exa 网络搜索请求之间的最小间隔（毫秒）；0 关闭节流",
	"Check thresholds at safe mid-turn tool-loop boundaries before the next provider request":
		"在回合内安全的工具循环边界、下一次供应商请求前检查阈值",
	"Enable 4-voice recall (vector, graph, fact, temporal) fused with reciprocal rank fusion":
		"启用四路召回（向量、图、事实、时序），以倒数排名融合",
	"How a settled terminal resize refreshes transcript rows retained in terminal scrollback":
		"终端窗口尺寸变化稳定后，如何刷新保留在回滚区里的对话行",
	"Prevent editing of files that appear to be auto-generated (protoc, sqlc, swagger, etc.)":
		"阻止编辑疑似自动生成的文件（protoc、sqlc、swagger 等）",
	"Enable the lsp tool for code intelligence (definitions, references, diagnostics, rename)":
		"启用 lsp 工具提供代码智能（定义、引用、诊断、重命名）",
	"Prune older read results when the same file is read again (cache-aware, runs every turn)":
		"同一文件再次读取时清理旧的读取结果（缓存感知，每回合运行）",
	"Remove the 1-character horizontal padding from the left and right of the terminal output":
		"去掉终端输出左右的 1 字符水平内边距",
	"Keep interactive sessions on the primary until confirmed; background agents auto-fallback":
		"交互会话保持主账号直到确认；后台代理自动回退",
	"Let standalone ultrathink request maximum automatic thinking and append its hidden notice":
		"允许独立 ultrathink 请求最大自动思考并追加其隐藏提示",
	"Move the prompt's bottom border to a separate row so macOS IME preedit cannot displace it":
		"提示词下边框独占一行，避免 macOS 输入法预编辑挤动",
	"Run the secret obfuscator over /share snapshots before upload (uses the secrets.* config)":
		"/share 快照上传前跑一遍密钥混淆（使用 secrets.* 配置）",
	"Save project role models in .musepi/config.yml; missing project roles use global defaults":
		"项目角色模型存入 .musepi/config.yml；缺失的项目角色用全局默认",
	"Render Markdown read results as formatted terminal Markdown previews instead of raw source":
		"Markdown 读取结果渲染为终端排版预览，而非原始源码",
	"Endpoint routing strategy for google-antigravity providers (chat, search, image, discovery)":
		"google-antigravity 供应商的端点路由策略（chat、search、image、discovery）",
	"Websocket policy for OpenAI Codex models (auto uses model defaults, on forces, off disables)":
		"OpenAI Codex 模型的 WebSocket 策略（auto 随模型默认，on 强制，off 禁用）",
	"Load the default rules shipped with the agent (override individually with ttsr.disabledRules)":
		"加载代理内置默认规则（可用 ttsr.disabledRules 逐条覆盖）",
	"Refresh generated session titles after todo init replans unless the title was set by the user":
		"todo init 重新规划后刷新生成的会话标题（用户手动改过的不动）",
	"Suppress post-edit LSP diagnostics already shown for a file; only surface new or changed ones":
		"抑制文件已显示过的编辑后 LSP 诊断；只出现新增或变化的",
	"Surface the active model identifier in the system prompt so the agent knows which model it is":
		"在系统提示中暴露当前模型标识，让代理知道自己是什么模型",
	"Interrupt the agent mid-stream when output matches rule patterns (Time-Traveling Stream Rules)":
		"输出命中规则模式时中断代理流（Time-Traveling Stream Rules）",
	"Obfuscate configured secrets and redact credential-shaped tokens before sending to AI providers":
		"发送给 AI 供应商前混淆已配置密钥并遮蔽凭据形 token",
	"Within this window, cached issue/PR view rows are returned directly (seconds; default 5 minutes)":
		"此窗口内直接返回缓存的 issue/PR 视图行（秒；默认 5 分钟）",
	"Ask the official registry first, then try the public mirror if the failure is one it could answer":
		"先问官方仓库，失败属于其可答类型时再试公共镜像",
	"Cache rendered issue/PR view output in ~/.musepi/cache/github-cache.db so repeated reads are free":
		"把渲染好的 issue/PR 视图缓存在 ~/.musepi/cache/github-cache.db，重复读取零开销",
	"Maximum concurrent Ollama Cloud subagent runs per process; 0 disables the provider-specific limit":
		"每进程 Ollama Cloud 子代理最大并发数；0 关闭该供应商专项限制",
	"Optional path to an exact Ruby executable. When set, automatic Ruby runtime discovery is skipped.":
		"Ruby 可执行文件的精确路径。设置后跳过自动 Ruby 运行时发现。",
	"Instruct upstream providers to completely omit thinking summaries from responses (where supported)":
		"指示上游供应商在响应中完全省略思考摘要（在支持的情况下）",
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
console.log(`replaced ${n} identity values with translations${apply ? "" : " (dry run)"}`);
