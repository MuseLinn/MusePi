/**
 * `settings.compaction` namespace dictionaries (context → compaction rows).
 *
 * The Chinese dictionary defines the key set; the English one is checked
 * complete against it at compile time. Schema UI fields carry these keys (not
 * English source text), and the merged domain map resolves them on both
 * surfaces (GUI and TUI).
 */
export const settingsCompaction = {
	"settings.compaction.group.core": "压缩",
	"settings.compaction.group.behavior": "压缩行为",
	"settings.compaction.group.limits": "压缩上限",
	"settings.context.group.experimental": "实验性",

	"settings.compaction.autoCompact.title": "自动压缩",
	"settings.compaction.autoCompact.desc": "接近上下文上限时自动压缩对话。",

	"settings.compaction.threshold.title": "压缩阈值",
	"settings.compaction.threshold.desc":
		"上下文用量达到窗口的这个比例时触发压缩。「默认」按预留空间推算，会随模型窗口大小变化；百分比在所有模型上表现一致。",
	"settings.compaction.threshold.option.default": "默认",
	"settings.compaction.threshold.option.default.desc": "按预留空间推算触发点",

	"settings.compaction.tokenLimit.title": "固定 Token 上限",
	"settings.compaction.tokenLimit.desc":
		"可选的绝对上限，设置后覆盖百分比。仅用于把上下文压到模型物理窗口以下（长上下文加价档位或注意力明显下降）。选「默认」恢复按百分比。",
	"settings.compaction.tokenLimit.option.default": "默认",
	"settings.compaction.tokenLimit.option.default.desc": "使用百分比阈值",
	"settings.compaction.tokenLimit.option.25k": "25K",
	"settings.compaction.tokenLimit.option.25k.desc": "200K 窗口的 1/8",
	"settings.compaction.tokenLimit.option.50k": "50K",
	"settings.compaction.tokenLimit.option.50k.desc": "200K 窗口的 1/4",
	"settings.compaction.tokenLimit.option.100k": "100K",
	"settings.compaction.tokenLimit.option.100k.desc": "200K 窗口的 1/2",
	"settings.compaction.tokenLimit.option.150k": "150K",
	"settings.compaction.tokenLimit.option.150k.desc": "200K 窗口的 3/4",
	"settings.compaction.tokenLimit.option.190k": "190K",
	"settings.compaction.tokenLimit.option.190k.desc": "略低于部分供应商开始加倍计费长上下文的位置",
	"settings.compaction.tokenLimit.option.200k": "200K",
	"settings.compaction.tokenLimit.option.200k.desc": "标准上下文窗口",
	"settings.compaction.tokenLimit.option.300k": "300K",
	"settings.compaction.tokenLimit.option.300k.desc": "大上下文窗口",
	"settings.compaction.tokenLimit.option.500k": "500K",
	"settings.compaction.tokenLimit.option.500k.desc": "超大上下文窗口",

	"settings.compaction.methodOrder.title": "压缩方式顺序",
	"settings.compaction.methodOrder.desc": "按顺序尝试这些压缩方式；不可用或失败时自动换下一种。",
	"settings.compaction.method.remote.title": "OpenAI 服务端压缩",
	"settings.compaction.method.remote.desc": "当前路由支持时，使用供应商原生的 OpenAI 兼容服务端压缩。",
	"settings.compaction.method.snapcompact.title": "Snapcompact",
	"settings.compaction.method.snapcompact.desc": "把历史归档成密集位图，由当前视觉模型读回；不额外调用模型。",
	"settings.compaction.method.handoff.title": "交接文档",
	"settings.compaction.method.handoff.desc": "生成交接文档，并以它作为压缩摘要继续。",
	"settings.compaction.method.soft.title": "摘要压缩",
	"settings.compaction.method.soft.desc": "用压缩模型就地生成摘要，不走服务端压缩。",
	"settings.compaction.method.shake.title": "裁剪重内容",
	"settings.compaction.method.shake.desc": "就地丢弃可恢复的重内容，不调用模型。",

	"settings.compaction.midTurn.title": "轮中压缩",
	"settings.compaction.midTurn.desc":
		"在工具步骤之间、下次模型请求前检查阈值；子智能体的整个任务只有一轮，因此始终检查。",

	"settings.compaction.backgroundPre.title": "后台预压缩",
	"settings.compaction.backgroundPre.desc": "接近阈值时先在后台生成摘要，越过阈值后直接拼接，压缩不再让你等待。",

	"settings.compaction.speculationCacheGuard.title": "缓存冷时跳过预压缩",
	"settings.compaction.speculationCacheGuard.desc":
		"只在最近一次响应的提示缓存仍有效时在后台生成摘要；长时间离开后它会让整个前缀重新计费，并和你的下一条请求抢缓存。关闭后始终预压缩。",

	"settings.compaction.remoteV2.title": "远程压缩 V2",
	"settings.compaction.remoteV2.desc": "对支持服务端压缩的模型使用流式压缩响应。",

	"settings.compaction.handoffDocs.title": "保存交接文档",
	"settings.compaction.handoffDocs.desc": "使用 Handoff 方式时，把生成的交接文档另存为 Markdown。",

	"settings.compaction.supersedeReads.title": "清理过期读取",
	"settings.compaction.supersedeReads.desc": "同一文件被再次读取时，丢弃较早的读取结果（感知缓存，每轮运行）。",

	"settings.compaction.dropUseless.title": "清理空结果",
	"settings.compaction.dropUseless.desc":
		"工具结果被消费后，丢弃「无匹配」或「等待超时」这类没有信息量的结果（感知缓存）。",

	"settings.compaction.perModelEnabled.title": "按模型覆盖",
	"settings.compaction.perModelEnabled.desc": "让按模型配置的条目取代全局阈值。",

	"settings.compaction.perModel.title": "按模型阈值",
	"settings.compaction.perModel.desc":
		"键为 `provider/model-id` 或 `provider/*` 前缀；数字是以该值为基准缩放百分比，`f90000` 是固定触发点，`80%` 直接替换百分比。`{}` 表示不覆盖。",

	"settings.compaction.notesBacked.title": "笔记驱动的上下文窗口（实验性）",
	"settings.compaction.notesBacked.desc": "跨上下文窗口保留持久笔记与可搜索的原始历史。",

	"settings.compaction.idle.title": "空闲压缩",
	"settings.compaction.idle.desc": "会话空闲且仍超过阈值时，在后台压缩。",

	"settings.compaction.idleThreshold.title": "空闲阈值",
	"settings.compaction.idleThreshold.desc": "空闲压缩使用的绝对 token 阈值，与常规触发阈值相互独立。",
	"settings.compaction.idleThreshold.option.100k": "100K",
	"settings.compaction.idleThreshold.option.200k": "200K",
	"settings.compaction.idleThreshold.option.300k": "300K",
	"settings.compaction.idleThreshold.option.400k": "400K",
	"settings.compaction.idleThreshold.option.500k": "500K",
	"settings.compaction.idleThreshold.option.600k": "600K",
	"settings.compaction.idleThreshold.option.700k": "700K",
	"settings.compaction.idleThreshold.option.800k": "800K",
	"settings.compaction.idleThreshold.option.900k": "900K",

	"settings.compaction.idleDelay.title": "空闲压缩延迟",
	"settings.compaction.idleDelay.desc":
		"空闲多久后开始压缩；配置了 1 小时 prompt cache 时，会等到缓存即将过期再压缩。",
	"settings.compaction.idleDelay.option.1m": "1 分钟",
	"settings.compaction.idleDelay.option.2m": "2 分钟",
	"settings.compaction.idleDelay.option.5m": "5 分钟",
	"settings.compaction.idleDelay.option.10m": "10 分钟",
	"settings.compaction.idleDelay.option.30m": "30 分钟",
	"settings.compaction.idleDelay.option.1h": "1 小时",

	"settings.compaction.editor.title": "按模型编辑",
	"settings.compaction.editor.model": "模型",
	"settings.compaction.editor.pick": "选择模型",
	"settings.compaction.editor.value": "触发值",
	"settings.compaction.editor.save": "保存",
	"settings.compaction.editor.remove": "移除",
	"settings.compaction.editor.empty": "还没有按模型覆盖。",
	"settings.compaction.editor.invalid": "使用 `provider/model-id` 或 `provider/*`，值填 token 数、`f90000` 或 `80%`。",
	"settings.compaction.editor.hint": "在上方填写后保存；`{}` 表示没有任何覆盖。",
} as const;

/** The `settings.compaction` key union (the zh dictionary is the source). */
export type SettingsCompactionKey = keyof typeof settingsCompaction;
