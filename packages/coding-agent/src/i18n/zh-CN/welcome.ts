export const welcome = {
	// ── Welcome screen ────────────────────────────────────
	"Welcome back!": "欢迎回来！",
	"No recent sessions": "没有最近的会话",
	"No LSP servers": "没有 LSP 服务器",
	"Please use nerdfont 😭.": "请使用 Nerd 字体 😭。",
	"Tip: ": "提示: ",
	"NEW!": "新!",

	// ── Welcome tips ────────────────────────────────────────────────────────────
	"Tired of typing \"keep going\"? Just send a '.'": "厌倦了打“继续”？发一个 '.' 就行",
	"You can /btw to ask a side question": "可用 /btw 提出旁路问题",
	"Use /tan to fork the current conversation into a background agent": "用 /tan 把当前对话分叉到后台代理",
	"Ctrl+D can be used to exit, but with your draft saved!": "Ctrl+D 可退出，草稿已保存！",
	"Find out which model you emotionally abuse the most with `musepi stats`":
		"用 `musepi stats` 看看你最常情感虐待的模型",
	"Try task isolation to create CoW worktrees": "试试任务隔离，创建 CoW 工作树",
	"Need a cheap nested model call? Use `completion(x...)`. Have a big batch of tasks? Ask clanker to use it!":
		"需要廉价的嵌套模型调用？用 `completion(x...)`。有一大批任务？让 clanker 用上它！",
	"Spaghetti code? Try complaining with /omfg": "面条代码？试试用 /omfg 抱怨",
	"Did you know? Each kitty/tmux/cmux/zellij/wezterm split keeps its own session — `musepi -c` resumes the right one":
		"你知道吗？每个 kitty/tmux/cmux/zellij/wezterm 分屏都有自己的会话——`musepi -c` 恢复正确的那个",
	"Drop the word `ultrathink` in your message for harder multi-step reasoning — watch it glow rainbow as you type":
		"在消息里加上 `ultrathink` 进行更深的多步推理——输入时它发出彩虹光",
	"Say `orchestrate` in your message to drive a multi-phase task with parallel subagents — watch it glow as you type":
		"在消息中说 `orchestrate`，用并行子代理驱动多阶段任务——输入时它会发光",
	"Say `workflowz` in your message to drive the task with parallel subagents in eval — watch it glow as you type":
		"在消息中说 `workflowz`，在 eval 中用并行子代理驱动任务——输入时它会发光",
	"Log in to several accounts of the same provider — /login again — and musepi load-balances across them automatically":
		"登录同一提供商的多个账户——再次 /login——musepi 自动在它们之间负载均衡",
	"Run `musepi auth-broker serve` once and every machine pulls live tokens over the wire — refresh keys never leave the host; `musepi auth-gateway` fronts it as a drop-in proxy any OpenAI-compatible client can hit":
		"运行一次 `musepi auth-broker serve`，每台机器都实时拉取令牌——刷新密钥永不离开主机；`musepi auth-gateway` 作为任何 OpenAI 兼容客户端可用的即插即用代理",
	"Press alt+p (or /switch) to switch provider, and ctrl+p to cycle role models smol -> slow -> etc":
		"按 alt+p（或 /switch）切换提供商，按 ctrl+p 循环切换角色模型 smol -> slow -> …",
	"Press ctrl+r to search your prompt history and reuse a past message": "按 ctrl+r 搜索提示历史并复用过去的消息",
	"`/force read` pins the next turn to one specific tool when the model keeps reaching for the wrong one":
		"模型总是拿错工具时，`/force read` 把下一轮固定到特定工具",
	"`/copy code` grabs the last code block to your clipboard — `/copy cmd` grabs the last shell/python command":
		"`/copy code` 把最后一个代码块复制到剪贴板——`/copy cmd` 复制最后一条 shell/python 命令",
	"`/shake` rips heavy tool results out of context to reclaim tokens without a full /compact — `/shake images` drops just images":
		"`/shake` 把沉重的工具结果移出上下文以回收令牌，无需完整 /compact——`/shake images` 只丢弃图片",
	"Pair up live: `/collab` shares your session through an end-to-end encrypted relay link — a teammate runs `/join <link>` to watch tool calls stream and prompt the agent from their own musepi":
		"实时配对：`/collab` 通过端到端加密的中继链接共享会话——队友运行 `/join <link>` 观看工具调用流，并从他们自己的 musepi 向代理发提示",
	"Press ← ← to drill into a running or finished agent and inspect its tool calls and transcript":
		"按 ← ← 深入运行中或已完成的代理，检查其工具调用与记录",
	"Hit a Codex rate limit? `/usage reset` spends a saved reset credit to immediately restore your quota":
		"遇到 Codex 速率限制？`/usage reset` 消耗一个已保存的重置额度立即恢复配额",
	"No native tool_calling? Inference provider botches parsing them? `PI_DIALECT=glm|kimi|anthropic…` rolls it locally for them!":
		"没有原生 tool_calling？推理提供商解析出错？`PI_DIALECT=glm|kimi|anthropic…` 为它们在本地处理！",
	"Turn on /advisor to attach a second model that reviews every turn and quietly injects advice":
		"开启 /advisor 附加第二个模型，它审查每一轮并悄悄注入建议",
	"Try starting your prompt with a ->, and writing a list (1. Do X, 2. Do Y)":
		"试着用 -> 开头，并写一个列表（1. 做 X，2. 做 Y）",
	"Press shift+tab to cycle through reasoning effort levels": "按 shift+tab 循环切换推理投入级别",
} as const;

/** Key union for the welcome domain (mirrors the desktop-web locale split). */
export type WelcomeKey = keyof typeof welcome;
