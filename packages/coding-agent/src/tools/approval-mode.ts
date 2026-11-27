import type { Settings } from "../config/settings";
import type { ApprovalMode } from "./approval";

/**
 * Where the effective approval mode for one tool call came from.
 *
 * A person-facing surface reports this rather than the bare mode: a bot lane
 * running `yolo` because its own identity preset says so reads very differently
 * from a workbench session that never chose one.
 */
export type ApprovalModeSource = "auto-approve" | "turn" | "session" | "identity" | "global";

/** The layers that can decide a tool call's approval mode, most specific first. */
export interface ApprovalModeLayers {
	/** `--auto-approve`: the session runs every tier without asking. */
	autoApprove?: boolean;
	/** A single submission's one-off selection. */
	turn?: ApprovalMode;
	/** The session's own selection. */
	session?: ApprovalMode;
	/** The owning identity's preset — a bot lane's bot, or a subagent's own mode. */
	identity?: ApprovalMode;
}

export interface ResolvedApprovalMode {
	readonly mode: ApprovalMode;
	readonly source: ApprovalModeSource;
}

/** The mode a session runs when nothing more specific decided. */
export const DEFAULT_APPROVAL_MODE: ApprovalMode = "yolo";

/**
 * Resolve one tool call's approval mode, most specific layer first.
 *
 * `autoApprove` outranks every layered selection: it is a session-scoped CLI
 * grant (`--auto-approve`), and a narrower layer must not quietly take it back
 * and start prompting a run the person asked to be unattended.
 *
 * This is the only place an approval mode is read out of settings. Every
 * caller — the tool wrapper, the Cursor bridge, the render path — resolves
 * through here, so a new layer cannot take effect in one call site and miss
 * another.
 */
export function resolveApprovalMode(
	settings: Pick<Settings, "get"> | undefined,
	layers: ApprovalModeLayers = {},
): ResolvedApprovalMode {
	if (layers.autoApprove === true) return { mode: "yolo", source: "auto-approve" };
	if (layers.turn !== undefined) return { mode: layers.turn, source: "turn" };
	if (layers.session !== undefined) return { mode: layers.session, source: "session" };
	if (layers.identity !== undefined) return { mode: layers.identity, source: "identity" };
	const configured = settings?.get("tools.approvalMode") as ApprovalMode | undefined;
	return { mode: configured ?? DEFAULT_APPROVAL_MODE, source: "global" };
}

/** Per-tool policy overrides (`tools.approval`), read beside the mode. */
export function resolveApprovalPolicies(settings: Pick<Settings, "get"> | undefined): Record<string, unknown> {
	return (settings?.get("tools.approval") ?? {}) as Record<string, unknown>;
}
