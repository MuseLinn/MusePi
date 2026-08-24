import type { ReactNode } from "react";
import type { RpcClient } from "../lib/rpc";
import { ModelSelector } from "./ModelSelector";
import { type ThinkingLevel, ThinkingSelector } from "./ThinkingSelector";

/**
 * Composer model/thinking capsule (dsh single-trigger parity): ONE pill
 * showing the current model AND thinking level, split into two segments —
 * the left opens the model menu, the right the thinking-effort menu. Each
 * segment keeps its own floating menu (mutex in useFloatingMenu allows
 * only one open at a time, so the pill never shows two menus). The pill
 * itself is a plain flex row of the two capsule-mode selectors plus a
 * divider; both selectors keep their full menu content (search, favorites,
 * DEFAULT pin / effort ladder with per-model ceiling) unchanged.
 *
 * Width budget: at narrow composer widths the segment labels collapse to
 * icon-only (TUI compactThinkingLevel parity) via the container query on
 * the pill — the menus still carry the full labels.
 */
export function ModelThinkingCapsule({
	rpc,
	sessionId,
	onModelSelect,
	onSetThinking,
	presetModelId,
	currentModelId,
	thinkingLevel,
	thinkingConfigLevel,
	thinkingCeiling,
	thinkingEfforts,
	allowSetDefault = false,
}: {
	rpc: RpcClient;
	sessionId: string | null;
	onModelSelect?(modelId: string | null, provider?: string): void;
	onSetThinking?(level: ThinkingLevel | null): void;
	presetModelId?: string | null;
	currentModelId?: string | null;
	thinkingLevel?: string | null;
	/** Configured selector state (auto vs pinned) — menu highlight; the
	 *  chip label shows thinkingLevel (the resolved effort). */
	thinkingConfigLevel?: string | null;
	thinkingCeiling?: string | null;
	thinkingEfforts?: readonly string[] | null;
	allowSetDefault?: boolean;
}): ReactNode {
	return (
		<div className="gui-model-capsule">
			<ModelSelector
				rpc={rpc}
				sessionId={sessionId}
				presetId={presetModelId}
				currentModelId={currentModelId}
				allowSetDefault={allowSetDefault}
				onSelect={onModelSelect}
				capsule
			/>
			{onSetThinking && (
				<>
					<div className="gui-model-capsule-sep" aria-hidden="true" />
					<ThinkingSelector
						value={thinkingLevel}
						configValue={thinkingConfigLevel}
						onChange={onSetThinking}
						ceiling={thinkingCeiling}
						efforts={thinkingEfforts}
						capsule
					/>
				</>
			)}
		</div>
	);
}
