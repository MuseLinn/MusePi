export const composer = {
	// ── Composer ──────────────────────────────────────────────────────────────
	"composer.typeYourResponse": "输入您的回复…",
	"composer.readOnlySessionWatching": "只读会话 — 仅观看",
	"composer.askAnythingCommands.info": "问任何事，/ 命令，@ 上下文…",
	"composer.waitingSession": "等待会话…",
	"composer.submitResponse": "提交回复",
	"composer.send": "发送（回车）",
	"composer.workingActive": "工作中",
	"composer.stopTurn": "停止",
	"composer.stopCurrentTurn": "停止当前回合",
	"composer.compactContext": "压缩上下文",
	"composer.compacting": "压缩中…",
	"composer.stopCompaction": "停止压缩",
	"composer.compactionFailed": "压缩失败",
	"composer.retryLastTurn": "重试上一轮",
	"composer.nothingRetry": "无可重试",
	"composer.markProgress": "标记进行中",
	"composer.abandonTask": "放弃任务",
	"composer.removeTask": "删除任务",
	"composer.addTask": "添加任务…",
	"composer.viewOnly": "仅查看",

	// ── Ask editor ────────────────────────────────────────────────────────────
	"composer.text": "（推荐）",
	"composer.recommended": "推荐",
	"composer.multi": "多选",
	"composer.noSelection": "未选择",
	"composer.autoSelectedAfterTimeout": "超时后自动选择 — 非用户选择",
	"composer.selectMultipleChoose.info": "可多选 — 逐项点选，最后选 Next 提交",
	"composer.next": "Next 提交",
	"composer.cancelAsk": "取消回答",

	// ── Slash commands (composer / TUI parity) ─────────────────────────
	"composer.unknownSlashCommand": "未知命令",
	"composer.commandOnlyWorksTerminal": "该命令仅在终端中可用",
	"composer.skillNotFound": "未找到该技能",
	"composer.slashCommandFailed": "命令执行失败",
	// ── Bash commands (! / !! composer, TUI parity) ────────────────────
	"composer.bashCommandFailed": "命令执行失败",
	"composer.bashCommandCancelled": "命令已取消",
	"composer.bashExitedCodeWithCodeWithLines": "命令以退出码 {code} 结束（{lines} 行输出）",
	"composer.bashOutputExcludedContext": "输出已从上下文排除",
	"composer.cancelled": "已取消",
	"composer.showAll": "显示全部",
	"composer.lines": "行",

	// ── Long text paste gate (TUI large-paste parity) ─────────────────
	"composer.pastedLinesWithLinesWithChars": "粘贴了 {lines} 行（{chars} 字符）",
	"composer.discardPaste": "放弃粘贴",
	"composer.pasteInline": "直接粘贴",
	"composer.wrapAttachment": "包裹为附件",
	"composer.wrapCodeBlock": "包裹为代码块",
	"composer.attachFile": "附加为文件",

	// ── Image attachments (collab prompt.images; design 「Session 附件流」) ──
	// "add images" lives in the general domain already.
	"composer.takePhoto": "拍照",
	"composer.chooseLibrary": "从相册选择",
	"composer.removeAttachment": "移除附件",
	"composer.attachImagesHint": "图片长边压到 1568px · JPEG 80%（小于 1.5MB 原样发送）",

	// ── General file attachments (fs.write channel; openchamber parity) ─────
	"composer.addAttachments": "添加附件",
	"composer.attachmentUploadFailed": "附件上传失败",
	"composer.attachmentExpiredReAdd": "附件已失效，请重新添加",
	"composer.noWorkspaceAttachments": "会话还没有工作区，无法上传附件",
	"composer.modelThinking": "模型与思考",
	"composer.hostSessionModel": "宿主会话当前模型",

	// ── 附件提及（Kimi 桌面端对齐）：chip → 输入框 token，渲染为 accent pill + hover 预览 ──
	"composer.mentionAttachment": "提及",
	"composer.mentionImageWithN": "提及图片 {n}",
	"composer.mentionFileWithN": "提及文件 {n}",

	// ── Voice input (daemon stt.transcribe; design 「语音四帧」) ──────────────
	// "voice input" / "voice recording stop" / "voice transcribing" /
	// "recording…" live in the settings domain already — reuse, don't duplicate.
	"composer.voiceDone": "完成",
	"composer.voiceDiscard": "放弃录音",
	"composer.voiceFailedWithReason": "语音输入失败：{reason}",
	"composer.voiceNeedsDaemonBackend": "语音输入需要 daemon 后端",
	"composer.voiceNeedsDaemonBody": "collab 直连会话暂不支持语音转写，通过 daemon 连接后可用",
	"composer.voiceGuideOk": "知道了",
	"composer.ttsNeedsDaemonBackend": "朗读需要 daemon 后端",
	// ── SketchPad (Codex 绘画 parity) ─────────────────────────────────────
	"composer.sketch": "绘画",
	"composer.sketchToolSelect": "选择",
	"composer.sketchToolPen": "画笔",
	"composer.sketchToolEraser": "橡皮",
	"composer.sketchToolText": "文本",
	"composer.sketchToolShapes": "形状",
	"composer.sketchToolLine": "直线",
	"composer.sketchToolArrow": "箭头",
	"composer.sketchToolRect": "矩形",
	"composer.sketchToolEllipse": "椭圆",
	"composer.sketchToolDiamond": "菱形",
	"composer.sketchToolTriangle": "三角形",
	"composer.sketchToolStar": "五角星",
	"composer.sketchToolHeart": "心形",
	"composer.sketchThickness": "粗细",
	"composer.sketchColor": "颜色",
	"composer.sketchTextPlaceholder": "输入文字…",
	"composer.sketchUndo": "撤销",
	"composer.sketchRedo": "重做",
	"composer.sketchClear": "清空",
	"composer.sketchDone": "完成",
	"composer.sketchExportLight": "导出浅色底（不随主题）",
	"composer.sketchDiscardTitle": "放弃这次绘画？",
	"composer.sketchDiscardConfirm": "画布上有未发送的内容，丢弃后无法恢复。",
	// ── Design session style select (M3.7b §3) ───────────────────────────
	"composer.designStyle": "设计风格",
	"composer.designStyleInherit": "跟随既有",
	"composer.designStyleMinimal": "极简留白",
	"composer.designStyleGlass": "玻璃拟态",
	"composer.designStyleEditorial": "编辑杂志",
	"composer.designStyleNeubrutalism": "新粗野",
	"composer.designStyleDarkneon": "暗黑霓虹",
	"composer.designStyleHint": "选择设计体系，注入会话的设计简报（选中即生效）",
	"composer.designSystemRailTitle": "设计体系",
	"composer.designSystemBuiltin": "内置",
	"composer.designSystemExtension": "扩展",
	"composer.designSystemMarketCta": "市场",
	"composer.designSystemMarketAria": "去能力中心市场发现更多设计体系",
	"composer.designSystemPreviewCta": "按钮",
	"composer.designEmptyPlaceholder": "描述你想设计的界面、风格与情绪，/ 可用命令…",

	// ── Attach「＋」sub-pickers (M2-2.6): enabled plugins / workspace files ──
	"composer.plusEnabledPlugins": "已启用插件",
	"composer.plusEnabledPluginsDesc": "插入插件名作为上下文提及",
	"composer.plusWorkspaceFiles": "当前工作区文件",
	"composer.plusWorkspaceFilesDesc": "插入 @相对路径 提及文件",
	"composer.plusPickerSearch": "搜索…",
	"composer.plusPickerLoading": "加载中…",
	"composer.plusPickerLoadFailed": "加载失败",
	"composer.plusPickerEnabledBadge": "已启用",
	"composer.plusPickerNoPlugins": "还没有已启用的插件",
	"composer.plusPickerNoFiles": "工作区还没有文件",
	"composer.plusPickerNoResults": "没有匹配的结果",
	"composer.plusPickerTruncated": "已显示前 {n} 条 — 输入更多字符缩小范围",
} as const;

/** Key union for the composer domain (source of truth). */
export type ComposerKey = keyof typeof composer;
