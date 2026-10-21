import { applyBatch } from "./schema-batch-apply.ts";

const TRANSLATIONS: Record<string, string> = {
	// ── Display / transcript rendering ────────────────────────────────
	"Hide Tool Activity": "隐藏工具活动",
	"Hide model-initiated tool calls and results from the transcript": "在对话中隐藏模型发起的工具调用及其结果",
	"Streaming rendering": "流式渲染",
	"Reveal assistant text and streamed tool input smoothly while chunks arrive":
		"内容分块到达时平滑显示助手文字与流式工具输入",
	"Resize Scrollback": "重整历史滚动区",
	"How a settled terminal resize refreshes transcript rows retained in terminal scrollback":
		"终端窗口尺寸变化稳定后，如何刷新保留在终端回滚区里的对话行",
	"Show Token Usage": "显示 Token 用量",
	"Show per-turn token usage on assistant messages": "在助手消息上显示每轮的 token 用量",
	"Collapse Compacted History": "折叠已压缩历史",
	"Collapse pre-compaction history behind the summary divider on the live transcript; disable (default) to keep the full transcript inline with dividers at each compaction point — folding compacted history hides entries from the navigation tree and trajectory jumps":
		"把压缩点之前的历史折叠进摘要分隔线之后；关闭（默认）则完整保留对话并在每个压缩点显示分隔线——折叠会把这些条目从导航树和轨迹跳转里隐藏",

	// ── Speech / TTS ───────────────────────────────────────────────────
	"Speech rate (0.5–2)": "语速（0.5–2）",
	"Playback rate for local TTS — 0.8× is common for reading aloud.": "本地语音朗读的播放速率——朗读常用 0.8×。",
	"On-device neural TTS (Kokoro-82M / MeloTTS 中文); output is WAV/PCM16":
		"端侧神经语音（Kokoro-82M / MeloTTS 中文）；输出为 WAV/PCM16",
	"On-device neural TTS model (Kokoro-82M English-first, MeloTTS 中文 for Mandarin/mixed)":
		"端侧神经语音模型（Kokoro-82M 偏英语，MeloTTS 中文 支持普通话/混合）",
	"Voice used by the local TTS backend — the voice picker under each tier in Settings manages it":
		"本地语音后端使用的音色——设置里各档位下方的音色选择器管理它",
	"Dictation barge-in": "听写打断",
	"What happens to playback when dictation starts: duck (drop volume) or pause.":
		"开始听写时朗读如何处理：降低音量或暂停。",
	"Auto-read new replies": "自动朗读新回复",
	"Automatically read aloud new assistant replies via the local TTS engine": "通过本地语音引擎自动朗读新的助手回复",
	"BCP-47 hint passed to the speech model (e.g. zh, yue, en, ja). Empty = auto-detect":
		"传给语音模型的 BCP-47 语言提示（如 zh、yue、en、ja）。留空自动检测",

	// ── Computer / permissions ─────────────────────────────────────────
	"Screen Glow Indicator": "屏幕辉光指示",
	"While the computer tool operates the host desktop, show a full-screen glow edge, so remote operation is never silent":
		"计算机工具操控桌面时显示全屏辉光边缘，远程操作不再无声进行",
	"Enable the scriptable host-desktop control tool (screenshots, input, accessibility)":
		"启用可脚本化的桌面控制工具（截图、输入、辅助功能）",

	// ── Plugin / registry ──────────────────────────────────────────────
	"Plugin Install Source": "插件安装来源",
	"Custom Plugin Registry URL": "自定义插件仓库地址",
	"Package manager": "包管理器",
	"Registry URL used when the install source is set to Custom. Takes effect on the next install":
		"安装来源设为「自定义」时使用的仓库地址。下次安装生效",
	"Which package registry installs plugins from. Auto asks the official registry first, then the public mirror if it fails":
		"插件从哪个包仓库安装。自动模式先问官方仓库，失败再用公共镜像",
	"Ask the official registry first, then try the public mirror if the failure is on our side":
		"先问官方仓库，失败在我们这边时再试公共镜像",
	"Use whatever the package manager is configured with (.npmrc, bunfig.toml)":
		"使用包管理器已有的配置（.npmrc、bunfig.toml）",

	// ── Browser ────────────────────────────────────────────────────────
	"Browser Relay": "浏览器中继",
	"Browser Relay URL": "浏览器中继地址",
	"musepi browser relay endpoint (default http://127.0.0.1:9224).":
		"musepi 浏览器中继地址（默认 http://127.0.0.1:9224）。",
	"Drive the in-app managed browser (the desktop GUI's right-pane browser, Electron only)":
		"驱动应用内托管浏览器（桌面 GUI 右栏浏览器，仅 Electron）",
	"Web Search Timeout": "网络搜索超时",

	// ── Misc ───────────────────────────────────────────────────────────
	"Agnes Video Generation": "Agnes 视频生成",
	"Shared Language Servers": "共享语言服务器",
	"Share one language server per project across musepi instances via the daemon broker":
		"通过 daemon 中转，让每个项目的语言服务器在多个 musepi 实例间共享",
	"Silence threshold (ms)": "静音阈值（毫秒）",
	"How long of a pause counts as the end of dictation.": "停顿多久算作听写结束。",

	// ── Status line / appearance ───────────────────────────────────────
	"Solid accent line, no context feedback": "纯强调色线条，无上下文反馈",
	"Used portion in accent color, remainder dimmed": "已用部分强调色，其余变暗",
	"Visual layout of the input editor and status line": "输入编辑器与状态线的视觉形态",
	Appearance: "外观",

	// ── User-level prompts / system prompt ─────────────────────────────
	"User-level system-prompt sections ({name, order, text}); applied to every session":
		"用户级系统提示词区块（{name, order, text}）；作用于每个会话",
	"Private scratchpad; not shown to user. Disables supported GPT, Claude, and Gemini thinking summaries":
		"私有草稿区；不展示给用户。关闭受支持的 GPT、Claude 与 Gemini 思考摘要",
};

applyBatch(TRANSLATIONS, process.argv.includes("--apply"));
