export {
	isKnownRoleName,
	isModelRole,
	isRoleThinkingLevel,
	MODEL_ROLES,
	RESERVED_MODEL_ROLES,
	ROLE_THINKING_LEVELS,
} from "./types.ts";
export type { ModelRole, ModelRolesConfig, ReservedModelRole, RoleModelSpec, RoleThinkingLevel } from "./types.ts";
export { formatSpecForLookup, parseRoleModelSpec } from "./parse.ts";
export type { ParseRoleSpecResult } from "./parse.ts";
export { resolveCandidatesForRole, resolveCycleOrder, resolveFallbackChain, resolveModelForRole } from "./resolve.ts";
export type { RoleResolution } from "./resolve.ts";
