/**
 * Host-half adapter for the Sharpshooter memory backend.
 *
 * The engine still lives in `sharpshooter/` and the core keeps it as the
 * built-in fallback, so the terminal and any host that does not mount
 * host-scope plugins behave exactly as before. What this package adds is the
 * registration path: mounted once per host process (`musepi.scope: "host"`),
 * it makes the backend a provider, which is the shape every further backend
 * extraction follows.
 *
 * Registration is process-wide by design — `memory.status` and the settings
 * page resolve a backend with no session, and a session-scoped mount would
 * register the same provider once per session.
 */
import type { ExtensionAPI } from "../../extensibility/extensions/types";
import { sharpshooterBackend } from "../../sharpshooter/backend";

export const name = "musepi-memory-sharpshooter";
export const inject = [] as const;
export const provide = [] as const;

export function apply(ctx: ExtensionAPI): void {
	ctx.memory.registerBackendProvider({
		id: "sharpshooter",
		label: "Sharpshooter",
		description: "Friction-gated project decision files, consolidated in the background.",
		create: () => sharpshooterBackend,
	});
}
