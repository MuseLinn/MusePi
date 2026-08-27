import { useCallback, useEffect, useState } from "react";
import type { RpcClient } from "../../lib/rpc";

export type VisionMode = "auto" | "on" | "off";

/**
 * session.modes toggle-relevant subset (TUI /fast /computer /vision
 * /prewalk parity): fast priority tier (enabled intent + whether the
 * active model actually realizes it), computer tool availability, the
 * inspect_image delegation mode, and the one-shot prewalk arm state.
 */
export interface ModeToggleState {
	fastModeEnabled: boolean;
	fastModeActive: boolean;
	computerEnabled: boolean;
	vision: { mode: VisionMode; active: boolean; model?: string | null };
	prewalk: { enabled: boolean; target?: { id: string } | null; thinkingLevel?: string | null };
}

const EMPTY: ModeToggleState = {
	fastModeEnabled: false,
	fastModeActive: false,
	computerEnabled: false,
	vision: { mode: "auto", active: false, model: null },
	prewalk: { enabled: false, target: null, thinkingLevel: null },
};

/** Pick + normalize the toggle fields out of the full session.modes
 *  response (goal/plan/todo ride along in the wire shape; this UI only
 *  consumes the four session-mode toggles). Defensive against an older
 *  daemon omitting any field. */
function parseModes(res: unknown): ModeToggleState {
	const r = (res ?? {}) as Record<string, unknown>;
	const vision = (r.vision ?? {}) as { mode?: string; active?: boolean; model?: string | null };
	const prewalk = (r.prewalk ?? {}) as {
		enabled?: boolean;
		target?: { id: string } | null;
		thinkingLevel?: string | null;
	};
	return {
		fastModeEnabled: r.fastModeEnabled === true,
		fastModeActive: r.fastModeActive === true,
		computerEnabled: r.computerEnabled === true,
		vision: {
			mode: vision.mode === "on" || vision.mode === "off" ? vision.mode : "auto",
			active: vision.active === true,
			model: vision.model ?? null,
		},
		prewalk: {
			enabled: prewalk.enabled === true,
			target: prewalk.target ?? null,
			thinkingLevel: prewalk.thinkingLevel ?? null,
		},
	};
}

/**
 * Session mode toggles for the composer footer (TUI /fast /computer
 * /vision /prewalk parity): polls session.modes every 10s while the
 * session id is present (visibility-gated like the goal/plan poll),
 * stores the toggle subset in local state, and exposes one-shot
 * mutations that round-trip through the daemon and merge the response
 * back immediately (no waiting for the next poll tick). Fail silently:
 * RPC errors keep the last known state.
 */
export function useModeToggles(
	rpc: RpcClient | null,
	sessionId: string,
): {
	state: ModeToggleState;
	toggleFast(): void;
	toggleComputer(): void;
	setVision(mode: VisionMode): void;
	armPrewalk(): void;
} {
	const [state, setState] = useState<ModeToggleState>(EMPTY);

	const refresh = useCallback((): void => {
		if (!rpc || !sessionId) return;
		void rpc
			.request<unknown>("session.modes", { sessionId })
			.then(res => {
				const next = parseModes(res);
				// Value-compare: skip the setState (and re-render) when the
				// toggle subset did not move (useModes pattern).
				setState(prev => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
			})
			.catch(() => {});
	}, [rpc, sessionId]);

	// 10s poll while the session id is present; pause while the tab is
	// hidden (background CPU + daemon RPCs for nothing — same visibility
	// gating as the goal/plan modes poll).
	useEffect(() => {
		if (!rpc || !sessionId) return;
		refresh();
		let id = setInterval(refresh, 10000);
		const onVis = (): void => {
			clearInterval(id);
			if (document.visibilityState === "visible") {
				refresh();
				id = setInterval(refresh, 10000);
			}
		};
		document.addEventListener("visibilitychange", onVis);
		return () => {
			clearInterval(id);
			document.removeEventListener("visibilitychange", onVis);
		};
	}, [refresh]);

	const toggleFast = useCallback((): void => {
		if (!rpc || !sessionId) return;
		void rpc
			.request<{ enabled: boolean; active: boolean }>("session.setFastMode", {
				sessionId,
				enabled: !state.fastModeEnabled,
			})
			.then(res => {
				if (res) setState(prev => ({ ...prev, fastModeEnabled: res.enabled, fastModeActive: res.active }));
			})
			.catch(() => {});
	}, [rpc, sessionId, state.fastModeEnabled]);

	const toggleComputer = useCallback((): void => {
		if (!rpc || !sessionId) return;
		void rpc
			.request<{ enabled: boolean }>("session.setComputerEnabled", {
				sessionId,
				enabled: !state.computerEnabled,
			})
			.then(res => {
				if (res) setState(prev => ({ ...prev, computerEnabled: res.enabled }));
			})
			.catch(() => {});
	}, [rpc, sessionId, state.computerEnabled]);

	const setVision = useCallback(
		(mode: VisionMode): void => {
			if (!rpc || !sessionId) return;
			void rpc
				.request<{ mode: VisionMode; active: boolean; model?: string | null }>("session.setVisionMode", {
					sessionId,
					mode,
				})
				.then(res => {
					if (res)
						setState(prev => ({ ...prev, vision: { mode: res.mode, active: res.active, model: res.model } }));
				})
				.catch(() => {});
		},
		[rpc, sessionId],
	);

	const armPrewalk = useCallback((): void => {
		if (!rpc || !sessionId) return;
		// One-shot arm with the fast small model (@smol role alias), the
		// same default the TUI /prewalk uses.
		void rpc
			.request<{
				armed: boolean;
				prewalk?: { enabled: boolean; target?: { id: string } | null; thinkingLevel?: string | null };
			}>("session.armPrewalk", { sessionId, model: "@smol" })
			.then(res => {
				if (!res) return;
				setState(prev => ({
					...prev,
					prewalk: res.prewalk ?? { enabled: res.armed, target: null, thinkingLevel: null },
				}));
			})
			.catch(() => {});
	}, [rpc, sessionId]);

	return { state, toggleFast, toggleComputer, setVision, armPrewalk };
}
