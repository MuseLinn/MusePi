// ============================================================
// MusePi en-US locale - English source strings for the TUI.
//
// Keys are namespaced ("<domain>.<name>"); values are the English
// text shown for en-US. Regenerated from scripts/i18n-key-migration.json
// (the namespaced-key migration's old-literal -> new-key map); do not
// hand-edit entries that exist in the migration map.
// ============================================================

import type { TranslationMap } from "../index.ts";

export const swarm: TranslationMap = {
	"swarm.aborted": "Aborted.",
	"swarm.abortedUser": "Aborted by the user",
	"swarm.agent": "Agent",
	"swarm.agentSingleSubAgent": "agent — single sub-agent with auto model routing",
	"swarm.agentSwarm": "Agent Swarm",
	"swarm.agentSwarmAutoRoutes": "agent_swarm — auto-routes models based on task type unless specified",
	"swarm.agentSwarmProvide.info": "agent_swarm: provide items (batch items) to run.",
	"swarm.batchParallelSame.info":
		"Batch parallel: same template applied to multiple items. Each item gets an isolated sub-agent.",
	"swarm.cancelAgainCancelSwarm": "/cancel again to cancel the swarm",
	"swarm.completed": "Completed.",
	"swarm.done": "done",
	"swarm.enterModelName": "Enter model name:",
	"swarm.failed": "Failed.",
	"swarm.goal": "Goal:",
	"swarm.imageMultimodalTasks.info":
		"For image/multimodal tasks, the system automatically prefers multimodal-capable models.",
	"swarm.kCtx": "k ctx",
	"swarm.modelRoutingAutomatic.desc":
		"Model routing is automatic: if you don't specify 'model', the system picks the best model based on task type, current session model, and available capabilities.",
	"swarm.multiModelSwarms.info": "For multi-model swarms, use model_map to assign different models per item.",
	"swarm.multimodal": " [multimodal]",
	"swarm.noModelsAvailable": "No models available.",
	"swarm.noModelsAvailableRegistry": "No models available in registry.",
	"swarm.other": "Other (type a model name)",
	"swarm.progress": "progress",
	"swarm.queued": "Queued...",
	"swarm.singleAgentDispatch.info": "Single agent dispatch: isolated sub-agent for a specific task.",
	"swarm.text": " (free)",
	"swarm.turns": "turns",
	"swarm.uncertainWhichModel.desc":
		"When uncertain which model is best, call ask_user_question to let the user choose — then pass their response as model/model_map.",
	"swarm.uncertainWhichModel.info":
		"When uncertain which model to use, call ask_user_question to let the user choose.",
	"swarm.unknownError": "Unknown error",
	"swarm.userMentionsSpecific.desc":
		"If the user mentions specific models (e.g., 'use deepseek' or '用mimo'), pass them through the 'model' or 'model_map' parameter.",
	"swarm.userMentionsSpecific.info": "If the user mentions a specific model name, pass it via the 'model' parameter.",
	"swarm.working": "Working...",
};
