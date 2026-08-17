/**
 * System domain — capability/feature discovery (architecture decision 5:
 * server-side gating of experimental UI, kimi-code /meta pattern) plus
 * daemon metadata.
 */
import { Type } from "@sinclair/typebox";
import type { MethodEntry } from "../index";

export const systemCapabilities = {
	method: "system.capabilities",
	auth: "public",
	params: Type.Object({}),
	result: Type.Object({
		protocol: Type.Number(),
		capabilities: Type.Record(Type.String(), Type.Boolean()),
	}),
	impl: "daemon self-description (static)",
} satisfies MethodEntry;

export const systemFeatures = {
	method: "system.features",
	auth: "public",
	params: Type.Object({}),
	result: Type.Record(Type.String(), Type.Boolean(), {
		description: "Effective experimental-flag snapshot (env/config/defaults merged, per-request live)",
	}),
	impl: "feature flags (kimi /meta experimental_flags pattern)",
} satisfies MethodEntry;

export const systemMeta = {
	method: "system.meta",
	auth: "public",
	params: Type.Object({}),
	result: Type.Object({
		version: Type.String(),
		engine: Type.String(),
		dataRoot: Type.Optional(Type.String()),
		configDir: Type.Optional(Type.String()),
		runtime: Type.Optional(Type.String()),
	}),
	impl: "daemon meta (musepi version + OMP engine version, derived)",
} satisfies MethodEntry;

export const systemMethods: MethodEntry[] = [systemCapabilities, systemFeatures, systemMeta];
