export const welcome = {
	// ── Welcome screen ────────────────────────────────────
	"welcome.welcomeBack": "欢迎回来！",
	"welcome.noRecentSessions": "没有最近的会话",
	"welcome.noLspServers": "没有 LSP 服务器",
	"welcome.pleaseUseNerdfont": "请使用 Nerd 字体 😭。",
	"welcome.tip": "提示: ",
	"welcome.new": "新!",

	// ── Welcome tips ────────────────────────────────────────────────────────────
	"Tired of typing \"keep going\"? Just send a '.'": "厌倦了打“继续”？发一个 '.' 就行",
	"welcome.youCanBtwAsk": "可用 /btw 提出旁路问题",
	"welcome.useTanForkCurrent": "用 /tan 把当前对话分叉到后台代理",
	"welcome.ctrlDCan.info": "Ctrl+D 可退出，草稿已保存！",
	"welcome.findOutWhich.info":
		"用 `musepi stats` 看看你最常情感虐待的模型",
	"welcome.tryTaskIsolationCreate": "试试任务隔离，创建 CoW 工作树",
	"welcome.needCheapNested.info":
		"需要廉价的嵌套模型调用？用 `completion(x...)`。有一大批任务？让 clanker 用上它！",
	"welcome.spaghettiCodeTry.info": "面条代码？试试用 /omfg 抱怨",
	"welcome.didYouKnow.info":
		"你知道吗？每个 kitty/tmux/cmux/zellij/wezterm 分屏都有自己的会话——`musepi -c` 恢复正确的那个",
	"welcome.dropWordUltrathink.info":
		"在消息里加上 `ultrathink` 进行更深的多步推理——输入时它发出彩虹光",
	"welcome.sayOrchestrateYour.info":
		"在消息中说 `orchestrate`，用并行子代理驱动多阶段任务——输入时它会发光",
	"welcome.sayWorkflowzYour.info":
		"在消息中说 `workflowz`，在 eval 中用并行子代理驱动任务——输入时它会发光",
	"welcome.logSeveralAccounts.info":
		"登录同一提供商的多个账户——再次 /login——musepi 自动在它们之间负载均衡",
	"welcome.runMusepiAuth.desc":
		"运行一次 `musepi auth-broker serve`，每台机器都实时拉取令牌——刷新密钥永不离开主机；`musepi auth-gateway` 作为任何 OpenAI 兼容客户端可用的即插即用代理",
	"welcome.pressAltP.info":
		"按 alt+p（或 /switch）切换提供商，按 ctrl+p 循环切换角色模型 smol -> slow -> …",
	"welcome.pressCtrlR.info": "按 ctrl+r 搜索提示历史并复用过去的消息",
	"welcome.forceReadPins.info":
		"模型总是拿错工具时，`/force read` 把下一轮固定到特定工具",
	"welcome.copyCodeGrabs.info":
		"`/copy code` 把最后一个代码块复制到剪贴板——`/copy cmd` 复制最后一条 shell/python 命令",
	"welcome.shakeRipsHeavy.desc":
		"`/shake` 把沉重的工具结果移出上下文以回收令牌，无需完整 /compact——`/shake images` 只丢弃图片",
	"welcome.pairUpLive.desc":
		"实时配对：`/collab` 通过端到端加密的中继链接共享会话——队友运行 `/join <link>` 观看工具调用流，并从他们自己的 musepi 向代理发提示",
	"welcome.pressDrillRunning.info":
		"按 ← ← 深入运行中或已完成的代理，检查其工具调用与记录",
	"welcome.hitCodexRate.info":
		"遇到 Codex 速率限制？`/usage reset` 消耗一个已保存的重置额度立即恢复配额",
	"welcome.noNativeTool.desc":
		"没有原生 tool_calling？推理提供商解析出错？`PI_DIALECT=glm|kimi|anthropic…` 为它们在本地处理！",
	"welcome.turnAdvisorAttach.info":
		"开启 /advisor 附加第二个模型，它审查每一轮并悄悄注入建议",
	"welcome.tryStartingYour.info":
		"试着用 -> 开头，并写一个列表（1. 做 X，2. 做 Y）",
	"welcome.pressShiftTabCycle": "按 shift+tab 循环切换推理投入级别",
} as const;

/** Key union for the welcome domain (mirrors the guest-client locale split). */
export type WelcomeKey = keyof typeof welcome;
