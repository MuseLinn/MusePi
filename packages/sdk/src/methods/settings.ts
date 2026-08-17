/**
 * Settings domain — read any level, write local-only.
 */
import { Type } from "@sinclair/typebox";
import type { MethodEntry } from "../index";

export const settingsGet = {
	method: "settings.get",
	auth: "session",
	params: Type.Object({
		keys: Type.Optional(Type.Array(Type.String())),
	}),
	result: Type.Any({ description: "Settings snapshot (or key subset)" }),
	impl: "config/settings.ts",
} satisfies MethodEntry;

export const settingsSet = {
	method: "settings.set",
	auth: "local",
	params: Type.Object({
		key: Type.String(),
		value: Type.Any(),
	}),
	result: Type.Object({ ok: Type.Boolean() }),
	impl: "config/settings.ts setter (local only)",
} satisfies MethodEntry;

export const settingsSchema = {
	method: "settings.schema",
	auth: "session",
	params: Type.Object({
		tabs: Type.Optional(Type.Array(Type.String())),
	}),
	result: Type.Any({ description: "UI metadata per tab (key/type/default/label/description/options)" }),
	impl: "config/settings-schema.ts",
} satisfies MethodEntry;

export const settingsMethods: MethodEntry[] = [settingsGet, settingsSet, settingsSchema];
