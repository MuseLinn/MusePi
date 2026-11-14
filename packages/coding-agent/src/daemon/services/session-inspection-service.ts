/**
 * SessionInspectionService — read-only live-session state the GUI renders
 * outside the transcript.
 *
 * Seam:
 * - Input: `session.contextUsage` and `session.thinkingInfo`, plus the live
 *   session the caller names.
 * - Output: the context-window ring (usage, window stats, snapcompact savings,
 *   category breakdown, compaction threshold) and the thinking controls
 *   (ceiling, level, resolved auto level, the model's effort ladder).
 * - Lifecycle: stateless; every value is read from the agent session at call
 *   time, so there is nothing to invalidate.
 */

import { effectiveReserveTokens, resolveThresholdTokens } from "@musepi/pi-agent-core/compaction";
import { getSupportedEfforts } from "@musepi/pi-catalog/model-thinking";
import { deriveWindowStats } from "@musepi/pi-wire";
import { cacheHitRate } from "../../modes/utils/cache-hit";
import type { DaemonSessionHost } from "../session-host";
import { estimateSnapcompactSavings } from "../session-host";
import type { DaemonService } from "./types";

export class SessionInspectionService implements DaemonService {
	readonly key = "session-inspection";
	readonly routes = {
		"session.contextUsage": "contextUsage",
		"session.thinkingInfo": "thinkingInfo",
	} as const;

	constructor(private readonly host: Pick<DaemonSessionHost, "get">) {}

	async contextUsage(params: unknown): Promise<unknown> {
		// Live context-window usage (TUI status-line parity): the
		// stats tracker's estimate feeds the composer's usage ring.
		// The snapcompact field carries the TUI /context savings
		// estimate when the experimental settings are enabled.
		const p = (params ?? {}) as { sessionId: string };
		const live = this.host.get(p.sessionId);
		if (!live) throw new Error(`Unknown session: ${p.sessionId}`);
		const stats = live.agentSession.getSessionStats();
		const usage = stats.contextUsage ?? null;
		if (!usage) return usage;
		// Visible-window timing fold for the composer stats row
		// (性能与用量 activity pill). The fold answers "what is in
		// the log now"; token figures stay on the durable projection
		// above, so paging/compaction never moves them.
		const windowStats = deriveWindowStats(live.agentSession.sessionManager.getEntries());
		const snapcompact = estimateSnapcompactSavings(live.agentSession);
		// Full category breakdown (TUI /context panel parity) for the
		// GUI's native /context dialog — the ring only needs the
		// aggregate, but the breakdown is already computed server-side.
		const breakdown = live.agentSession.getContextBreakdown({ contextWindow: usage.contextWindow }) ?? undefined;
		const m = live.agentSession.model;
		// Provider-qualified reference ("provider/id"): the model selector
		// highlights by exact row, so a bare id would match the FIRST
		// same-id model (opencode-go vs b-ai deepseek-v4-flash-vision-exp)
		// and the check would light the wrong provider's row.
		const modelRef = m ? (m.provider ? `${m.provider}/${m.id}` : m.id) : undefined;
		// Autocompact buffer + free tokens (TUI /context panel parity):
		// the buffer is the reserve the compaction strategy keeps below
		// the threshold; free is what's left after used + buffer.
		const cw = usage.contextWindow;
		const used = breakdown?.usedTokens ?? usage.tokens;
		let autoCompactBufferTokens = 0;
		let freeTokens = 0;
		// Effective compaction threshold in force (issue #42): when
		// the user configured a custom soft cap (e.g.
		// compaction.thresholdTokens: 300_000), every frontend usage
		// display can use it as the ring/status denominator instead
		// of the physical context window.
		let thresholdTokens: number | null = null;
		if (cw > 0) {
			const comp = live.agentSession.settings.getGroup("compaction") as
				| { enabled?: boolean; strategy?: string }
				| undefined;
			if (comp?.enabled && comp.strategy !== "off") {
				const threshold = resolveThresholdTokens(cw, comp as Parameters<typeof resolveThresholdTokens>[1]);
				thresholdTokens = threshold > 0 ? threshold : null;
				autoCompactBufferTokens = Math.max(0, cw - threshold);
			} else if (comp?.enabled) {
				autoCompactBufferTokens = effectiveReserveTokens(cw, comp as Parameters<typeof effectiveReserveTokens>[1]);
			}
			autoCompactBufferTokens = Math.min(autoCompactBufferTokens, Math.max(0, cw - used));
			freeTokens = Math.max(0, cw - used - autoCompactBufferTokens);
		}
		// Session token/cost summary + prompt-cache hit rate (issue #8,
		// TUI `cache_hit` segment parity). The GUI has no other source
		// for either: the context ring is window-percentage only, and
		// settings → agent stats is easy to miss. Hit rate is computed
		// here with the TUI's own helper so the two cannot disagree.
		const tokenStats = live.agentSession.sessionManager?.getUsageStatistics?.() ?? null;
		const hitRate = cacheHitRate(tokenStats);
		const tokenSummary =
			tokenStats || hitRate !== null
				? {
						input: tokenStats?.input ?? 0,
						output: tokenStats?.output ?? 0,
						cacheRead: tokenStats?.cacheRead ?? 0,
						cacheWrite: tokenStats?.cacheWrite ?? 0,
						totalTokens: tokenStats?.totalTokens ?? 0,
						cost: tokenStats?.cost ?? 0,
						cacheHitRate: hitRate,
					}
				: null;
		return snapcompact ||
			breakdown ||
			modelRef ||
			autoCompactBufferTokens > 0 ||
			tokenSummary ||
			thresholdTokens !== null
			? {
					...usage,
					...(modelRef ? { model: modelRef } : {}),
					...(snapcompact ? { snapcompact } : {}),
					...(breakdown ? { breakdown } : {}),
					...(tokenSummary ? { usage: tokenSummary } : {}),
					...(thresholdTokens !== null ? { thresholdTokens } : {}),
					autoCompactBufferTokens,
					freeTokens,
					windowStats,
				}
			: { ...usage, windowStats };
	}

	async thinkingInfo(params: unknown): Promise<unknown> {
		// Per-model thinking ceiling (TUI parity: some models cap the
		// effort ladder). Powers the GUI selector's disabled levels.
		const p = (params ?? {}) as { sessionId: string };
		const live = this.host.get(p.sessionId);
		if (!live) throw new Error(`Unknown session: ${p.sessionId}`);
		// AgentSession exposes the live controls on its model bus. The
		// current model rides along so the settings card can label the
		// live session's model without a separate snapshot round-trip.
		const model = live.agentSession.model;
		return {
			ceiling: live.agentSession.thinkingLevelCeiling,
			level: live.agentSession.thinkingLevel,
			auto: live.agentSession.isAutoThinking,
			// The level auto RESOLVED to for the current turn (undefined
			// until the daemon classifies; TUI status-line parity — the
			// GUI chip shows "auto" pending, then the concrete effort).
			resolved: live.agentSession.autoResolvedThinkingLevel(),
			// The current model's exact effort ladder (TUI parity: the
			// selector offers off/auto + getSupportedEfforts(model), not
			// a fixed seven-rung ladder).
			efforts: model ? getSupportedEfforts(model as never).map(e => String(e)) : [],
			model: model ? { id: model.id, name: model.name, provider: model.provider } : null,
		};
	}
}
