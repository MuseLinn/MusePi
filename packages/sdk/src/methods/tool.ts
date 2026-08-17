/**
 * Tool domain — registry listing + approval workflow. Approval maps to the
 * 18-level permission chain decision (ask/deny/auto). Inline approval cards in
 * the GUI call tool.approve/tool.deny; permission.policy decides levels.
 */
import { Type } from "@sinclair/typebox";
import type { MethodEntry } from "../index";

export const toolList = {
	method: "tool.list",
	auth: "session",
	params: Type.Object({}),
	result: Type.Array(
		Type.Object({
			name: Type.String(),
			description: Type.Optional(Type.String()),
			parameters: Type.Any({ description: "JSON schema" }),
			requiresApproval: Type.Optional(Type.Boolean()),
		}),
	),
	impl: "ToolRegistry / tools/index.ts",
} satisfies MethodEntry;

export const toolCall = {
	method: "tool.call",
	auth: "local",
	params: Type.Object({
		name: Type.String(),
		arguments: Type.Any(),
	}),
	result: Type.Any({ description: "ToolResult" }),
	impl: "tool runner (runtime)",
} satisfies MethodEntry;

export const toolApprove = {
	method: "tool.approve",
	auth: "session",
	params: Type.Object({
		requestId: Type.String(),
		/** session-scoped allow, per-file allow, or one-shot. */
		scope: Type.Optional(
			Type.Union([Type.Literal("once"), Type.Literal("session"), Type.Literal("file"), Type.Literal("directory")], {
				default: "once",
			}),
		),
	}),
	result: Type.Object({ ok: Type.Boolean() }),
	impl: "approval flow (runtime)",
} satisfies MethodEntry;

export const toolDeny = {
	method: "tool.deny",
	auth: "session",
	params: Type.Object({
		requestId: Type.String(),
	}),
	result: Type.Object({ ok: Type.Boolean() }),
	impl: "approval flow (runtime)",
} satisfies MethodEntry;

export const toolMethods: MethodEntry[] = [toolList, toolCall, toolApprove, toolDeny];
