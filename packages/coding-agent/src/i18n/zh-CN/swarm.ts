export const swarm = {
	// ── Swarm / Agent ──────────────────────────────────────
	"Agent Swarm": "Agent 蜂群",
	"Goal:": "目标:",
	turns: "轮次",
	"Completed.": "完成。",
	"Failed.": "失败。",
	"Aborted.": "已中止。",
	"Working...": "执行中...",
	"Queued...": "排队中...",
	"/cancel again to cancel the swarm": "/再按取消以中止集群",
	"Aborted by the user": "用户已中止",
	"Unknown error": "未知错误",
	"No models available in registry.": "注册表中没有可用模型。",
	"No models available.": "没有可用模型。",
	"agent_swarm: provide items (batch items) to run.": "agent_swarm: 请提供要运行的 items（批次项目）。",
	progress: "进度",
	done: "完成",
	" (free)": "（免费）",
	" [multimodal]": " [多模态]",
	"k ctx": "k 上下文",
	"Other (type a model name)": "其他（输入模型名称）",
	"Enter model name:": "输入模型名称:",
	Agent: "Agent",

	// ── Swarm Tool Definitions ────────────────────────────
	"Batch parallel: same template applied to multiple items. Each item gets an isolated sub-agent.":
		"批量并行：同一模板应用于多个项目。每个项目获得一个独立的子代理。",
	"agent_swarm — auto-routes models based on task type unless specified":
		"agent_swarm — 自动基于任务类型路由模型（除非指定）",
	"Single agent dispatch: isolated sub-agent for a specific task.": "单个代理调度：为特定任务创建独立的子代理。",
	"agent — single sub-agent with auto model routing": "agent — 单个子代理，自动模型路由",
	"Model routing is automatic: if you don't specify 'model', the system picks the best model based on task type, current session model, and available capabilities.":
		"模型路由是自动的：如果您不指定'model'，系统会根据任务类型、当前会话模型和可用能力自动选择最佳模型。",
	"If the user mentions specific models (e.g., 'use deepseek' or '用mimo'), pass them through the 'model' or 'model_map' parameter.":
		"如果用户提到特定模型（如'use deepseek'或'用mimo'），请通过'model'或'model_map'参数传递。",
	"For multi-model swarms, use model_map to assign different models per item.":
		"对于多模型集群，请使用 model_map 为每个项目分配不同的模型。",
	"When uncertain which model is best, call ask_user_question to let the user choose — then pass their response as model/model_map.":
		"如果不确定哪个模型最好，请调用 ask_user_question 让用户选择——然后将用户的回答作为 model/model_map 传入。",
	"For image/multimodal tasks, the system automatically prefers multimodal-capable models.":
		"对于图像/多模态任务，系统自动优先支持多模态的模型。",
	"If the user mentions a specific model name, pass it via the 'model' parameter.":
		"如果用户提到特定模型名称，请通过'model'参数传递。",
	"When uncertain which model to use, call ask_user_question to let the user choose.":
		"如果不确定使用哪个模型，请调用 ask_user_question 让用户选择。",
} as const;

/** Key union for the swarm domain (mirrors the desktop-web locale split). */
export type SwarmKey = keyof typeof swarm;
