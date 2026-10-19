export const swarm = {
	// ── Swarm / Agent ──────────────────────────────────────
	"swarm.agentSwarm": "Agent 蜂群",
	"swarm.goal": "目标:",
	"swarm.turns": "轮次",
	"swarm.completed": "完成。",
	"swarm.failed": "失败。",
	"swarm.aborted": "已中止。",
	"swarm.working": "执行中...",
	"swarm.queued": "排队中...",
	"swarm.cancelAgainCancelSwarm": "/再按取消以中止集群",
	"swarm.abortedUser": "用户已中止",
	"swarm.unknownError": "未知错误",
	"swarm.noModelsAvailableRegistry": "注册表中没有可用模型。",
	"swarm.noModelsAvailable": "没有可用模型。",
	"swarm.agentSwarmProvide.info": "agent_swarm: 请提供要运行的 items（批次项目）。",
	"swarm.progress": "进度",
	"swarm.done": "完成",
	"swarm.text": "（免费）",
	"swarm.multimodal": " [多模态]",
	"swarm.kCtx": "k 上下文",
	"swarm.other": "其他（输入模型名称）",
	"swarm.enterModelName": "输入模型名称:",
	"swarm.agent": "Agent",

	// ── Swarm Tool Definitions ────────────────────────────
	"swarm.batchParallelSame.info":
		"批量并行：同一模板应用于多个项目。每个项目获得一个独立的子代理。",
	"swarm.agentSwarmAutoRoutes":
		"agent_swarm — 自动基于任务类型路由模型（除非指定）",
	"swarm.singleAgentDispatch.info": "单个代理调度：为特定任务创建独立的子代理。",
	"swarm.agentSingleSubAgent": "agent — 单个子代理，自动模型路由",
	"swarm.modelRoutingAutomatic.desc":
		"模型路由是自动的：如果您不指定'model'，系统会根据任务类型、当前会话模型和可用能力自动选择最佳模型。",
	"swarm.userMentionsSpecific.desc":
		"如果用户提到特定模型（如'use deepseek'或'用mimo'），请通过'model'或'model_map'参数传递。",
	"swarm.multiModelSwarms.info":
		"对于多模型集群，请使用 model_map 为每个项目分配不同的模型。",
	"swarm.uncertainWhichModel.desc":
		"如果不确定哪个模型最好，请调用 ask_user_question 让用户选择——然后将用户的回答作为 model/model_map 传入。",
	"swarm.imageMultimodalTasks.info":
		"对于图像/多模态任务，系统自动优先支持多模态的模型。",
	"swarm.userMentionsSpecific.info":
		"如果用户提到特定模型名称，请通过'model'参数传递。",
	"swarm.uncertainWhichModel.info":
		"如果不确定使用哪个模型，请调用 ask_user_question 让用户选择。",
} as const;

/** Key union for the swarm domain (mirrors the guest-client locale split). */
export type SwarmKey = keyof typeof swarm;
