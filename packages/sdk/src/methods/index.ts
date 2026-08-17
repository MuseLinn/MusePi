export * from "./agent";
export * from "./collab";
export * from "./extended";
export * from "./permission";
export * from "./provider";
export * from "./session";
export * from "./settings";
export * from "./system";
export * from "./tool";

import type { MethodEntry } from "../index";
import { agentMethods } from "./agent";
import { collabMethods } from "./collab";
import { extendedMethods } from "./extended";
import { permissionMethods } from "./permission";
import { providerMethods } from "./provider";
import { sessionMethods } from "./session";
import { settingsMethods } from "./settings";
import { systemMethods } from "./system";
import { toolMethods } from "./tool";

/** Full method table, grouped by domain. */
export const METHODS: MethodEntry[] = [
	...systemMethods,
	...sessionMethods,
	...agentMethods,
	...toolMethods,
	...permissionMethods,
	...providerMethods,
	...settingsMethods,
	...collabMethods,
	...extendedMethods,
];

/** Auth level lookup: method name → TransportAuth. */
export const METHOD_AUTH: ReadonlyMap<string, string> = new Map(METHODS.map(m => [m.method, m.auth]));
