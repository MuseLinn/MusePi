import type { Settings } from "../config/settings";
import type { HindsightSessionState } from "../hindsight/state";

/** Where `retain`/`learn` store an item: the active project's scope, or the scope every project recalls. */
export type MemoryWriteScope = "project" | "global";

/** The parts of a tool session that decide whether `scope: "global"` is offered. */
export interface GlobalMemoryScopeSession {
	settings: Settings;
	getHindsightSessionState?: () => HindsightSessionState | undefined;
}

/**
 * Whether `retain`/`learn` can take `scope: "global"`: the active backend must have a destination that every
 * project recalls. MuseMem writes lessons to `memories/_global/learned.md`; `musemem.globalScope` turns that
 * destination off. Hindsight writes untagged memories; whether that is allowed comes from the session's
 * Hindsight state rather than live settings, because the retain queue enforces against that state's config
 * (a subagent alias keeps its parent's snapshot), so the schema never offers a scope the queue rejects.
 * The other backends have no such destination.
 */
export function isGlobalMemoryScopeAvailable(session: GlobalMemoryScopeSession): boolean {
	// Cast: config files migrate `local`, but programmatic overrides can still
	// carry the former id and must keep resolving to the same destination.
	const backend = session.settings.get("memory.backend") as string;
	switch (backend) {
		case "musemem":
		case "local":
			return session.settings.get("musemem.globalScope") !== false;
		case "mnemopi":
			return session.settings.get("mnemopi.scoping") !== "per-project";
		case "hindsight":
			return session.getHindsightSessionState?.()?.isGlobalRetainAvailable() ?? false;
		default:
			return false;
	}
}

/**
 * How a caller can turn global scope on, for the refusal a tool returns when it
 * is off. Naming the setting and the current restriction lets the model ask the
 * user for the right change instead of retrying the same scope.
 */
export function globalScopeHint(backendId: string): string {
	switch (backendId) {
		case "musemem":
		case "local":
			return "Enable `musemem.globalScope`";
		case "hindsight":
			return "Enable `hindsight.globalScope` and use global or per-project-tagged scoping";
		case "mnemopi":
			return "Change `mnemopi.scoping` from per-project";
		default:
			return "Select a backend that keeps a cross-project destination";
	}
}
