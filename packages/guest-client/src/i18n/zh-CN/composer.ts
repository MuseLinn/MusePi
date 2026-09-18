export const composer = {
	// ── Composer ──────────────────────────────────────────────────────────────
	"type your response…": "输入您的回复…",
	"read-only session — watching only": "只读会话 — 仅观看",
	"ask anything, / for commands, @ for context…": "问任何事，/ 命令，@ 上下文…",
	"waiting for session…": "等待会话…",
	"submit response": "提交回复",
	"send (Enter)": "发送（回车）",
	"working active": "工作中",
	"stop turn": "停止",
	"stop the current turn": "停止当前回合",
	"compact context": "压缩上下文",
	"compacting…": "压缩中…",
	"stop compaction": "停止压缩",
	"compaction failed": "压缩失败",
	"retry last turn": "重试上一轮",
	"nothing to retry": "无可重试",
	"mark in progress": "标记进行中",
	"abandon task": "放弃任务",
	"remove task": "删除任务",
	"add a task…": "添加任务…",
	"view-only": "仅查看",

	// ── Ask editor ────────────────────────────────────────────────────────────
	"(Recommended)": "（推荐）",
	recommended: "推荐",
	multi: "多选",
	"no selection": "未选择",
	"auto-selected after timeout — not a user choice": "超时后自动选择 — 非用户选择",
	"select multiple — choose each option, then pick Next": "可多选 — 逐项点选，最后选 Next 提交",
	Next: "Next 提交",
	"cancel ask": "取消回答",

	// ── Slash commands (composer / TUI parity) ─────────────────────────
	"unknown slash command": "未知命令",
	"this command only works in the terminal": "该命令仅在终端中可用",
	"skill not found": "未找到该技能",
	"slash command failed": "命令执行失败",
	// ── Bash commands (! / !! composer, TUI parity) ────────────────────
	"bash command failed": "命令执行失败",
	"bash command cancelled": "命令已取消",
	"bash exited with code {code} ({lines} lines)": "命令以退出码 {code} 结束（{lines} 行输出）",
	"bash output excluded from context": "输出已从上下文排除",
	cancelled: "已取消",
	"show all": "显示全部",
	lines: "行",

	// ── Long text paste gate (TUI large-paste parity) ─────────────────
	"Pasted {lines} lines ({chars} chars)": "粘贴了 {lines} 行（{chars} 字符）",
	"discard paste": "放弃粘贴",
	"paste inline": "直接粘贴",
	"wrap as attachment": "包裹为附件",
	"wrap as code block": "包裹为代码块",
	"attach as file": "附加为文件",

	// ── Image attachments (collab prompt.images; design 「Session 附件流」) ──
	// "add images" lives in the general domain already.
	"take photo": "拍照",
	"choose from library": "从相册选择",
	"remove attachment": "移除附件",
	"attach images hint": "图片长边压到 1568px · JPEG 80%（小于 1.5MB 原样发送）",

	// ── General file attachments (fs.write channel; openchamber parity) ─────
	"add attachments": "添加附件",
	"attachment upload failed": "附件上传失败",
	"attachment expired re-add": "附件已失效，请重新添加",
	"no workspace for attachments": "会话还没有工作区，无法上传附件",
	"model & thinking": "模型与思考",
	"host session model": "宿主会话当前模型",

	// ── Voice input (daemon stt.transcribe; design 「语音四帧」) ──────────────
	// "voice input" / "voice recording stop" / "voice transcribing" /
	// "recording…" live in the settings domain already — reuse, don't duplicate.
	"voice done": "完成",
	"voice discard": "放弃录音",
	"voice failed: {reason}": "语音输入失败：{reason}",
	"voice needs daemon backend": "语音输入需要 daemon 后端",
	"voice needs daemon body": "collab 直连会话暂不支持语音转写，通过 daemon 连接后可用",
	"voice guide ok": "知道了",
	"tts needs daemon backend": "朗读需要 daemon 后端",
} as const;

/** Key union for the composer domain (source of truth). */
export type ComposerKey = keyof typeof composer;
