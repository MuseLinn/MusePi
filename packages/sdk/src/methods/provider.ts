/**
 * Provider domain — model registry listing and switching (GUI top bar /
 * command palette). Reads are session-level (remote display), switch is
 * local (session state mutation).
 */
import { Type } from "@sinclair/typebox";
import type { MethodEntry } from "../index";

export const providerList = {
	method: "provider.list",
	auth: "session",
	params: Type.Object({}),
	result: Type.Array(
		Type.Object({
			id: Type.String(),
			name: Type.String(),
			models: Type.Array(Type.String()),
			authenticated: Type.Boolean(),
		}),
	),
	impl: "ModelRegistry / config/model-registry.ts",
} satisfies MethodEntry;

export const providerSwitch = {
	method: "provider.switch",
	auth: "local",
	params: Type.Object({
		providerId: Type.String(),
		modelId: Type.Optional(Type.String()),
	}),
	result: Type.Object({ ok: Type.Boolean(), model: Type.Optional(Type.String()) }),
	impl: "AgentSession.setModel() / provider switch (runtime)",
} satisfies MethodEntry;

export const providerModels = {
	method: "provider.models",
	auth: "session",
	params: Type.Object({
		providerId: Type.Optional(Type.String()),
	}),
	result: Type.Array(Type.Any({ description: "Model catalog entries" })),
	impl: "@musepi/pi-catalog",
} satisfies MethodEntry;

export const providerMethods: MethodEntry[] = [providerList, providerSwitch, providerModels];
