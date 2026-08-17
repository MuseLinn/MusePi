/**
 * Permission domain — the 18-level permission chain policy. Read at any
 * auth level (so remote clients can see policy), writes are local-only.
 */
import { Type } from "@sinclair/typebox";
import type { MethodEntry } from "../index";

export const permissionPolicy = {
	method: "permission.policy",
	auth: "session",
	params: Type.Object({}),
	result: Type.Any({ description: "Permission chain levels + effective policy" }),
	impl: "permission chain (config/policy)",
} satisfies MethodEntry;

export const permissionSet = {
	method: "permission.set",
	auth: "local",
	params: Type.Object({
		/** e.g. { "level": 5 } or per-tool overrides. */
		patch: Type.Any(),
	}),
	result: Type.Object({ ok: Type.Boolean() }),
	impl: "permission chain mutation (local only)",
} satisfies MethodEntry;

export const permissionGrant = {
	method: "permission.grant",
	auth: "local",
	params: Type.Object({
		path: Type.String(),
		scope: Type.Union([Type.Literal("file"), Type.Literal("directory")]),
		expiresAt: Type.Optional(Type.String()),
	}),
	result: Type.Object({ ok: Type.Boolean() }),
	impl: "approval memory (runtime)",
} satisfies MethodEntry;

export const permissionMethods: MethodEntry[] = [permissionPolicy, permissionSet, permissionGrant];
