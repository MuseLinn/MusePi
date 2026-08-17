/**
 * Agent domain — subagent registry, lifecycle, progress, cross-session
 * messaging. Maps to `registry/agent-registry.ts` (AgentRegistry /
 * AgentLifecycleManager) and the task subagent event bus
 * (`BusChannel: task:subagent:progress|lifecycle`).
 */
import { Type } from "@sinclair/typebox";
import type { MethodEntry } from "../index";

export const agentList = {
	method: "agent.list",
	auth: "session",
	params: Type.Object({
		includeArchived: Type.Optional(Type.Boolean({ default: false })),
	}),
	result: Type.Array(
		Type.Object({
			id: Type.String(),
			kind: Type.Union([Type.Literal("main"), Type.Literal("sub")]),
			name: Type.Optional(Type.String()),
			status: Type.String(),
			parentId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
		}),
	),
	impl: "AgentRegistry snapshot (runtime)",
} satisfies MethodEntry;

export const agentProgress = {
	method: "agent.progress",
	auth: "session",
	params: Type.Object({
		agentId: Type.String(),
	}),
	result: Type.Any({ description: "SubagentProgressPayload — stage + progress" }),
	impl: "event bus task:subagent:progress (runtime)",
} satisfies MethodEntry;

export const agentAttach = {
	method: "agent.attach",
	auth: "session",
	params: Type.Object({
		agentId: Type.String(),
	}),
	result: Type.Object({
		stream: Type.String(),
		transcript: Type.Any({ description: "AgentHubRemoteTranscript" }),
	}),
	impl: "agent-hub / AgentHubRemote (runtime)",
} satisfies MethodEntry;

export const agentMessage = {
	method: "agent.message",
	auth: "local",
	params: Type.Object({
		agentId: Type.String(),
		text: Type.String(),
	}),
	result: Type.Object({ delivered: Type.Boolean() }),
	impl: "cross-session messaging (hub/irc, runtime)",
} satisfies MethodEntry;

export const agentTerminate = {
	method: "agent.terminate",
	auth: "local",
	params: Type.Object({ agentId: Type.String() }),
	result: Type.Object({ ok: Type.Boolean() }),
	impl: "AgentLifecycleManager.terminate() (runtime)",
} satisfies MethodEntry;

export const agentMethods: MethodEntry[] = [agentList, agentProgress, agentAttach, agentMessage, agentTerminate];
